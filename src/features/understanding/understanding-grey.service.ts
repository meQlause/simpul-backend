import type { PoolClient } from 'pg';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { EmbeddingPort, ModelPort } from '../../platform/llm/port.js';
import { z } from 'zod';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { modelInput } from './understanding.triage.repository.js';
import { greyOutput, queryPayload } from './understanding.schema.js';
import { greyChoice } from './understanding.rules.js';
import { hasOutcome, lockUnlabelledUnit } from './understanding.repository.js';
import { askQuestion, resolutionFacts } from './understanding.questions.repository.js';
import { quarantine } from './understanding.comprehension.js';
import {
  conversationContext,
  greyCandidates,
  readResolution,
  settleResolution,
} from './understanding-resolution.repository.js';
import { searchContext, type SearchFound } from './understanding-embed.service.js';
import { SEARCH_EXTRA_CANDIDATES, mergeConversation } from './understanding-search.rules.js';

type Scope = { workspaceId: string; unitId: string };
type Message = { messageId: string; text: string };
type Services = {
  resolveConnection: ConnectionResolver;
  model: ModelPort;
  now: () => Date;
  alert: (event: unknown) => void;
  publishQuestion?: (
    tx: PoolClient,
    payload: { workspaceId: string; questionId: string },
  ) => Promise<unknown>;
  embedding?: EmbeddingPort;
  embeddingModel?: string;
};
type Candidate = { id: string; displayId: string; customer: string | null; summary: string };
type Input = {
  bodySafe: string;
  evidenceMessageIds: string[];
  conversation: Message[];
  candidates: Candidate[];
  candidateIds: string[];
};
type Decision = 'done' | 'create' | { threadId: string };
type Choice = ReturnType<typeof greyChoice>;
type Answer = z.infer<typeof greyOutput>;

const defaultTemperature = 0.2;

function decode(text: string) {
  try {
    return greyOutput.safeParse(JSON.parse(text));
  } catch {
    return null;
  }
}

// The group is asked, and the question is published in the same transaction.
async function askGroup(
  tx: PoolClient,
  services: Services,
  scope: Scope,
  question: { candidateIds: string[]; contextMessageCount: number },
) {
  const facts = await resolutionFacts(tx, scope);
  const questionId = await askQuestion(
    tx,
    { ...scope, channelId: facts?.channelId ?? '' },
    question.candidateIds,
    services.now(),
  );

  if (!questionId) {
    return;
  }

  await settleResolution(tx, scope, {
    decidedBy: 'question',
    contextMessageCount: question.contextMessageCount,
  });
  await services.publishQuestion?.(tx, { workspaceId: scope.workspaceId, questionId });
}

type Context = { services: Services; scope: Scope };

async function writeDecision(
  tx: PoolClient,
  { services, scope }: Context,
  unitInput: Input,
  choice: Choice,
): Promise<Decision> {
  if (!(await lockUnlabelledUnit(tx, scope))) {
    return 'done';
  }

  const contextMessageCount = unitInput.conversation.length;

  if (choice.kind === 'attach') {
    await settleResolution(tx, scope, {
      decidedBy: 'model_context',
      chosenThreadId: choice.threadId,
      contextMessageCount,
    });

    return { threadId: choice.threadId };
  }

  if (choice.kind === 'create') {
    await settleResolution(tx, scope, { decidedBy: 'model_context', contextMessageCount });

    return 'create';
  }

  await askGroup(tx, services, scope, {
    candidateIds: unitInput.candidateIds,
    contextMessageCount,
  });

  return 'done';
}

async function settle(
  services: Services,
  scope: Scope,
  unitInput: Input,
  choice: Choice,
): Promise<Decision> {
  return scopedTransaction(services.resolveConnection, scope.workspaceId, (tx) =>
    writeDecision(tx, { services, scope }, unitInput, choice),
  );
}

async function readGrey(
  tx: PoolClient,
  scope: Scope,
  retrieved: Message[],
): Promise<Input | Decision> {
  const resolution = await readResolution(tx, scope);

  if (!resolution || resolution.verdict !== 'GREY') {
    return 'create';
  }

  if (resolution.decidedBy === 'question' || (await hasOutcome(tx, scope))) {
    return 'done';
  }

  if (resolution.decidedBy === 'model_context') {
    return resolution.chosenThreadId ? { threadId: resolution.chosenThreadId } : 'create';
  }

  const message = await modelInput(tx, scope);

  if (!message) {
    return 'done';
  }

  return {
    bodySafe: message.bodySafe,
    evidenceMessageIds: message.evidenceMessageIds,
    conversation: mergeConversation(await conversationContext(tx, scope), retrieved),
    candidates: await greyCandidates(tx, scope.workspaceId, resolution.candidateIds),
    candidateIds: resolution.candidateIds,
  };
}

async function loadInput(
  services: Services,
  scope: Scope,
  retrieved: Message[],
): Promise<Input | Decision> {
  return scopedTransaction(services.resolveConnection, scope.workspaceId, (tx) =>
    readGrey(tx, scope, retrieved),
  );
}

// One answer from the model: the first temperature, then the second if the first is not valid JSON.
async function askModel(services: Services, scope: Scope, input: Input) {
  for (const temperature of [defaultTemperature, 0]) {
    const text = await services.model.generate({
      workspaceId: scope.workspaceId,
      mode: 'grey',
      tier: 'strong',
      bodySafe: input.bodySafe,
      temperature,
      responseSchema: z.toJSONSchema(greyOutput),
      context: {
        operations: [],
        evidenceMessageIds: input.evidenceMessageIds,
        conversation: input.conversation,
        candidates: input.candidates,
      },
    });
    const decoded = decode(text);

    if (decoded?.success) {
      return decoded.data;
    }
  }

  return null;
}

function supplied(input: Input) {
  return {
    candidateIds: input.candidateIds,
    messageIds: [
      ...input.evidenceMessageIds,
      ...input.conversation.map((entry) => entry.messageId),
    ],
  };
}

// The searched work joins the candidates, not yet offered, at most three (FR-RES-06).
async function withSearch(services: Services, scope: Scope, input: Input, found: SearchFound) {
  const offered = new Set(input.candidateIds);
  const added = found.threadIds.filter((id) => !offered.has(id)).slice(0, SEARCH_EXTRA_CANDIDATES);
  const candidates = await scopedTransaction(services.resolveConnection, scope.workspaceId, (tx) =>
    greyCandidates(tx, scope.workspaceId, added),
  );

  return {
    ...input,
    conversation: mergeConversation(input.conversation, found.conversation),
    candidates: [...input.candidates, ...candidates],
    candidateIds: [...input.candidateIds, ...candidates.map((candidate) => candidate.id)],
  };
}

// Decides a grey-zone unit: a cited candidate, a cited new work, or a question to the group (FR-RES-02).
// `retrieved` is the context a genesis search found; an unsure answer may search once more (FR-RES-06).
export async function comprehendGreyUnit(
  services: Services,
  payload: Scope,
  retrieved: Message[] = [],
): Promise<Decision> {
  const scope = queryPayload.parse(payload);
  const input = await loadInput(services, scope, retrieved);

  if (typeof input === 'string' || !('bodySafe' in input)) {
    return input as Decision;
  }

  const answer = await askModel(services, scope, input);

  if (!answer) {
    await quarantine(
      { resolveConnection: services.resolveConnection, alert: services.alert },
      scope,
    );

    return 'done';
  }

  const choice = greyChoice(answer, supplied(input));

  if (choice.kind === 'unsure' && answer.search) {
    return searchAndAskAgain(services, scope, input, answer);
  }

  return settle(services, scope, input, choice);
}

// An unsure answer that asked to search: the search adds context and candidates, and the model is asked once more.
// Its second answer is final; a second search is never run (AC5, AC8).
async function searchAndAskAgain(
  services: Services,
  scope: Scope,
  input: Input,
  answer: Answer,
): Promise<Decision> {
  const found = answer.search ? await searchContext(services, scope, answer.search) : null;

  if (!found) {
    return settle(services, scope, input, greyChoice(answer, supplied(input)));
  }

  const extended = await withSearch(services, scope, input, found);
  const second = await askModel(services, scope, extended);

  return settle(
    services,
    scope,
    extended,
    second ? greyChoice(second, supplied(extended)) : { kind: 'unsure' },
  );
}
