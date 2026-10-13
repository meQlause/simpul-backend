import type { PoolClient } from 'pg';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { ModelPort } from '../../platform/llm/port.js';
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

type Scope = { workspaceId: string; unitId: string };
type Services = {
  resolveConnection: ConnectionResolver;
  model: ModelPort;
  now: () => Date;
  alert: (event: unknown) => void;
  publishQuestion?: (
    tx: PoolClient,
    payload: { workspaceId: string; questionId: string },
  ) => Promise<unknown>;
};
type Candidate = { id: string; displayId: string; customer: string | null; summary: string };
type Input = {
  bodySafe: string;
  evidenceMessageIds: string[];
  conversation: { messageId: string; text: string }[];
  candidates: Candidate[];
  candidateIds: string[];
};
type Decision = 'done' | 'create' | { threadId: string };
type Choice = ReturnType<typeof greyChoice>;

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

async function readGrey(tx: PoolClient, scope: Scope): Promise<Input | Decision> {
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
    conversation: await conversationContext(tx, scope),
    candidates: await greyCandidates(tx, scope.workspaceId, resolution.candidateIds),
    candidateIds: resolution.candidateIds,
  };
}

async function loadInput(services: Services, scope: Scope): Promise<Input | Decision> {
  return scopedTransaction(services.resolveConnection, scope.workspaceId, (tx) =>
    readGrey(tx, scope),
  );
}

// Decides a grey-zone unit: a cited candidate, a cited new work, or a question to the group (FR-RES-02).
export async function comprehendGreyUnit(services: Services, payload: Scope): Promise<Decision> {
  const scope = queryPayload.parse(payload);
  const input = await loadInput(services, scope);

  if (typeof input === 'string' || !('bodySafe' in input)) {
    return input as Decision;
  }

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
      const choice = greyChoice(decoded.data, {
        candidateIds: input.candidateIds,
        messageIds: [
          ...input.evidenceMessageIds,
          ...input.conversation.map((entry) => entry.messageId),
        ],
      });

      return settle(services, scope, input, choice);
    }
  }

  await quarantine({ resolveConnection: services.resolveConnection, alert: services.alert }, scope);

  return 'done';
}
