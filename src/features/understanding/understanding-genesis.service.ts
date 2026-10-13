import type { PoolClient } from 'pg';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { ModelPort } from '../../platform/llm/port.js';
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

type Scope = { workspaceId: string; unitId: string };
type Services = {
  resolveConnection: ConnectionResolver;
  model: ModelPort;
  now: () => Date;
  alert: (event: unknown) => void;
  publishMatcher?: OperationOptions['publishMatcher'];
};
type Context = NonNullable<Awaited<ReturnType<typeof loadContext>>>;
type Output = z.infer<typeof genesisOutput>;
const kernelMinimum = 2;
const defaultTemperature = 0.2;

async function loadContext(services: Services, scope: Scope) {
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
}

export async function comprehendGenesisUnit(services: Services, scope: Scope) {
  const context = await loadContext(services, scope);

  if (!context) {
    return;
  }

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
      },
    });
    const output = decode(text, context);

    if (output?.success) {
      await scopedTransaction(services.resolveConnection, scope.workspaceId, async (tx) => {
        if (await lockUnlabelledUnit(tx, scope)) {
          await writeGenesis(tx, { services, scope, context, output: output.data });
        }
      });

      return;
    }
  }

  const changed = await scopedTransaction(
    services.resolveConnection,
    scope.workspaceId,
    async (tx) =>
      (await lockUnlabelledUnit(tx, scope)) &&
      (await insertOrphan(tx, scope, 'model_invalid_json')),
  );

  if (changed) {
    services.alert({ ...scope, reason: 'model_invalid_json' });
  }
}
