import type { PoolClient } from 'pg';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { EmbeddingPort, ModelPort } from '../../platform/llm/port.js';
import { z } from 'zod';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { createFromGenesisInTransaction, attachGenesisEvidence } from '../work/index.js';
import { modelCategories, requireActiveCategory } from '../vocabulary/index.js';
import { modelInput } from './understanding.triage.repository.js';
import { runtimeUnit } from './understanding-runtime.repository.js';
import { hasOutcome, lockUnlabelledUnit, insertOrphan } from './understanding.repository.js';
import { persistOperation, type OperationOptions } from './understanding-operation.service.js';
import { genesisOutput } from './understanding.schema.js';
import { genesisGate } from './understanding.rules.js';
import {
  conversationContext,
  recordResolution,
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
  publishMatcher?: OperationOptions['publishMatcher'];
  embedding?: EmbeddingPort;
  embeddingModel?: string;
};
type Context = NonNullable<Awaited<ReturnType<typeof loadContext>>>;
type Output = z.infer<typeof genesisOutput>;
const kernelMinimum = 2;
const defaultTemperature = 0.2;

async function loadContext(services: Services, scope: Scope, retrieved: Message[]) {
  return scopedTransaction(services.resolveConnection, scope.workspaceId, async (tx) => {
    if (await hasOutcome(tx, scope)) {
      return null;
    }

    const source = await runtimeUnit(tx, scope);
    const input = await modelInput(tx, scope);

    return source && input
      ? {
          ...input,
          channelId: source.channelId,
          categories: await modelCategories(tx, scope.workspaceId),
          conversation: mergeConversation(await conversationContext(tx, scope), retrieved),
        }
      : null;
  });
}

function decode(text: string, context: Context) {
  try {
    return genesisOutput
      .refine(
        (output) =>
          (!output.genesis ||
            (context.categories.some((category) => category.id === output.genesis!.domainId) &&
              output.genesis.evidenceMessageIds.every((id) =>
                context.evidenceMessageIds.includes(id),
              ))) &&
          output.operations.every(
            (operation) =>
              !operation.retractsOpId &&
              operation.evidenceMessageIds.every((id) => context.evidenceMessageIds.includes(id)),
          ),
      )
      .safeParse(JSON.parse(text));
  } catch {
    return null;
  }
}

function rejection(output: Output) {
  const genesis = output.genesis;

  if (!genesis || genesisGate(genesis.intent)) {
    return 'G1';
  }

  if (genesis.tense !== 'sudah_terjadi') {
    return 'G2';
  }

  if ([genesis.who, genesis.what, genesis.action].filter(Boolean).length < kernelMinimum) {
    return 'G3';
  }

  // The genesis carries its own evidence (at least one supplied message id, checked in decode).
  // New work need not come with an operation; one without evidence is discarded (SRS §7.2).
  return genesis.completionCondition ? null : 'G4';
}

async function writeGenesis(
  tx: PoolClient,
  input: { services: Services; scope: Scope; context: Context; output: Output },
) {
  const { services, scope, context, output } = input;
  const reason = rejection(output);

  if (reason) {
    await insertOrphan(tx, scope, reason);

    return;
  }

  const genesis = output.genesis!;

  await requireActiveCategory(tx, scope.workspaceId, genesis.domainId);
  const now = services.now();
  const work = await createFromGenesisInTransaction(
    tx,
    scope.workspaceId,
    {
      domainId: genesis.domainId,
      channelId: context.channelId,
      summary: genesis.summary,
      confidence: genesis.confidence,
    },
    now,
  );

  if (!work) {
    await insertOrphan(tx, scope, 'low_genesis_confidence');

    return;
  }

  await attachGenesisEvidence(tx, scope.workspaceId, {
    threadId: work.id,
    messageIds: genesis.evidenceMessageIds,
    confidence: genesis.confidence,
    customerLabel: genesis.who,
    nextStep: genesis.completionCondition,
  });

  await recordGenesisOperations(tx, {
    scope: { ...scope, threadId: work.id },
    output,
    options: { now, publishMatcher: services.publishMatcher },
  });
}

async function recordGenesisOperations(
  tx: PoolClient,
  input: { scope: Scope & { threadId: string }; output: Output; options: OperationOptions },
) {
  for (const operation of input.output.operations) {
    if (operation.evidenceMessageIds.length) {
      await persistOperation(tx, input.scope, operation, input.options);
    }
  }

  // The message that started the work is labelled even when the model gave no operation for it,
  // so rules see the new work: a label citing genesis evidence routes as event "new".
  const genesis = input.output.genesis!;
  const covered = input.output.operations.some((operation) =>
    operation.evidenceMessageIds.some((id) => genesis.evidenceMessageIds.includes(id)),
  );

  if (!covered) {
    await persistOperation(
      tx,
      input.scope,
      {
        type: 'progress',
        tense: genesis.tense,
        evidenceMessageIds: genesis.evidenceMessageIds,
        confidence: genesis.confidence,
      },
      input.options,
    );
  }
}

// The search found work: the unit becomes GREY over it (at most three), and the grey step decides (FR-RES-06).
async function greyOverFound(services: Services, scope: Scope, found: SearchFound) {
  const threads = found.threadIds.slice(0, SEARCH_EXTRA_CANDIDATES);

  await scopedTransaction(services.resolveConnection, scope.workspaceId, async (tx) => {
    if (await lockUnlabelledUnit(tx, scope)) {
      await recordResolution(tx, scope, {
        verdict: 'GREY',
        decidedBy: 'search',
        candidates: threads.map((threadId) => ({ threadId, score: 0 })),
        chosenThreadId: null,
      });
    }
  });

  return found.conversation;
}

// One answer from the model: the first temperature, then the second if the first is not valid JSON.
async function askGenesis(services: Services, scope: Scope, context: Context) {
  for (const temperature of [defaultTemperature, 0]) {
    const text = await services.model.generate({
      workspaceId: scope.workspaceId,
      mode: 'genesis',
      tier: 'standard',
      bodySafe: context.bodySafe,
      temperature,
      responseSchema: z.toJSONSchema(genesisOutput),
      context: {
        operations: [],
        evidenceMessageIds: context.evidenceMessageIds,
        categories: context.categories,
        conversation: context.conversation,
      },
    });
    const output = decode(text, context);

    if (output?.success) {
      return output.data;
    }
  }

  return null;
}

async function writeAnswer(services: Services, scope: Scope, context: Context, output: Output) {
  await scopedTransaction(services.resolveConnection, scope.workspaceId, async (tx) => {
    if (await lockUnlabelledUnit(tx, scope)) {
      await settleResolution(tx, scope, { contextMessageCount: context.conversation.length });
      await writeGenesis(tx, { services, scope, context, output });
    }
  });
}

async function orphanInvalid(tx: PoolClient, scope: Scope) {
  return (
    (await lockUnlabelledUnit(tx, scope)) && (await insertOrphan(tx, scope, 'model_invalid_json'))
  );
}

// Asks the genesis once: a null genesis may search once (FR-RES-06). Returns the retrieved context when the unit
// is handed to the grey step, so the caller decides with it; returns nothing otherwise.
export async function comprehendGenesisUnit(
  services: Services,
  scope: Scope,
  retrieved: Message[] = [],
): Promise<Message[] | undefined> {
  const context = await loadContext(services, scope, retrieved);

  if (!context) {
    return undefined;
  }

  const output = await askGenesis(services, scope, context);

  if (!output) {
    await orphanOnInvalid(services, scope);

    return undefined;
  }

  return answer(services, scope, context, output);
}

async function orphanOnInvalid(services: Services, scope: Scope) {
  const changed = await scopedTransaction(services.resolveConnection, scope.workspaceId, (tx) =>
    orphanInvalid(tx, scope),
  );

  if (changed) {
    services.alert({ ...scope, reason: 'model_invalid_json' });
  }
}

// A null genesis may search once: linked work hands the unit to the grey step, unlinked results ask the genesis
// once more with them; anything else is written.
async function answer(services: Services, scope: Scope, context: Context, output: Output) {
  const found =
    !output.genesis && output.search ? await searchContext(services, scope, output.search) : null;

  if (found?.threadIds.length) {
    return greyOverFound(services, scope, found);
  }

  if (found) {
    return comprehendGenesisUnit(services, scope, found.conversation);
  }

  await writeAnswer(services, scope, context, output);

  return undefined;
}
