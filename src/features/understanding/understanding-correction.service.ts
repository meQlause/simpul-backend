import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { ModelPort } from '../../platform/llm/port.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { attachGenesisEvidence, createFromGenesisInTransaction } from '../work/index.js';
import { modelCategories, requireActiveCategory } from '../vocabulary/index.js';
import { modelInput } from './understanding.triage.repository.js';
import { operationContext } from './understanding-context.repository.js';
import { insertLabel } from './understanding.repository.js';
import { comprehensionOutput, genesisOutput } from './understanding.schema.js';
import { correctionRefusal } from './understanding-correction.rules.js';
import {
  closeOrphan,
  closeQuestion,
  insertCorrection,
  loadCorrectionFacts,
  lockCorrectionUnit,
  markAdminResolution,
  openTarget,
  type CorrectionFacts,
} from './understanding-correction.repository.js';
import {
  persistOperation,
  retract,
  type OperationOptions,
} from './understanding-operation.service.js';

type Scope = { workspaceId: string; unitId: string };
type Operation = Parameters<typeof insertLabel>[2];
type Refusal = { field: string; message?: string } | null;
type Publish = OperationOptions['publishMatcher'];

export type CorrectionServices = {
  resolveConnection: ConnectionResolver;
  model: ModelPort;
  now: () => Date;
  publishMatcher?: Publish;
};

export type CorrectionInput =
  | { action: 'create'; categoryId: string; summary?: string }
  | { action: 'attach'; workDisplayId: string };

export type Draft =
  | { action: 'create'; categoryId: string; summary: string }
  | {
      action: 'attach';
      target: { id: string; displayId: string };
      operations: Operation[];
    };

const NOT_FOUND = 'E-NOT-FOUND' as const;
const firstTemperature = 0.2;
const temperatures = [firstTemperature, 0];

function refuseIf(refusal: Refusal) {
  if (refusal) {
    throw new DomainError('E-VALIDATION', [{ ...refusal, issue: 'invalid' }]);
  }
}

// ponytail: the model's retractsOpId is dropped: moving a unit between works is the admin's act, not the model's.
function comprehensionOperations(text: string): Operation[] | null {
  try {
    const parsed = comprehensionOutput.safeParse(JSON.parse(text));

    return parsed.success
      ? parsed.data.operations.map((operation) => ({
          type: operation.type,
          tense: operation.tense,
          evidenceMessageIds: operation.evidenceMessageIds,
          confidence: operation.confidence,
        }))
      : null;
  } catch {
    return null;
  }
}

function genesisSummary(text: string): string | null {
  try {
    const parsed = genesisOutput.safeParse(JSON.parse(text));

    return parsed.success ? (parsed.data.genesis?.summary ?? null) : null;
  } catch {
    return null;
  }
}

async function askModel<T>(
  services: CorrectionServices,
  request: Omit<Parameters<ModelPort['generate']>[0], 'temperature'>,
  read: (text: string) => T | null,
): Promise<T | null> {
  for (const temperature of temperatures) {
    const decoded = read(await services.model.generate({ ...request, temperature }));

    if (decoded !== null) {
      return decoded;
    }
  }

  return null;
}

async function draftAttach(services: CorrectionServices, scope: Scope, displayId: string) {
  const loaded = await scopedTransaction(
    services.resolveConnection,
    scope.workspaceId,
    async (tx) => {
      const target = await openTarget(tx, scope.workspaceId, displayId, services.now());
      const message = await modelInput(tx, scope);

      return {
        target,
        facts: await loadCorrectionFacts(tx, scope),
        message:
          message && target
            ? {
                ...message,
                operations: await operationContext(tx, { ...scope, threadId: target.id }),
              }
            : null,
      };
    },
  );

  if (!loaded.target || !loaded.facts || !loaded.message) {
    throw new DomainError(NOT_FOUND);
  }

  refuseIf(correctionRefusal(loaded.facts, { action: 'attach', target: loaded.target }));

  const operations = await askModel(
    services,
    {
      workspaceId: scope.workspaceId,
      mode: 'comprehend',
      tier: 'standard',
      bodySafe: loaded.message.bodySafe,
      responseSchema: z.toJSONSchema(comprehensionOutput),
      context: {
        operations: loaded.message.operations,
        evidenceMessageIds: loaded.message.evidenceMessageIds,
      },
    },
    comprehensionOperations,
  );

  if (!operations) {
    throw new DomainError('E-INTERNAL');
  }

  return {
    action: 'attach' as const,
    target: { id: loaded.target.id, displayId: loaded.target.displayId },
    operations,
  };
}

async function draftCreate(
  services: CorrectionServices,
  scope: Scope,
  input: { categoryId: string; summary?: string },
) {
  const facts = await scopedTransaction(services.resolveConnection, scope.workspaceId, (tx) =>
    loadCorrectionFacts(tx, scope),
  );

  if (!facts) {
    throw new DomainError(NOT_FOUND);
  }

  refuseIf(correctionRefusal(facts, { action: 'create' }));

  if (input.summary) {
    return { action: 'create' as const, categoryId: input.categoryId, summary: input.summary };
  }

  const context = await scopedTransaction(
    services.resolveConnection,
    scope.workspaceId,
    async (tx) => ({
      message: await modelInput(tx, scope),
      categories: await modelCategories(tx, scope.workspaceId),
    }),
  );
  const summary = context.message
    ? await askModel(
        services,
        {
          workspaceId: scope.workspaceId,
          mode: 'genesis',
          tier: 'standard',
          bodySafe: context.message.bodySafe,
          responseSchema: z.toJSONSchema(genesisOutput),
          context: {
            operations: [],
            evidenceMessageIds: context.message.evidenceMessageIds,
            categories: context.categories,
          },
        },
        genesisSummary,
      )
    : null;

  if (!summary) {
    throw new DomainError('E-VALIDATION', [
      { field: 'summary', issue: 'required', message: 'Enter a short summary.' },
    ]);
  }

  return { action: 'create' as const, categoryId: input.categoryId, summary };
}

// Everything slow or fallible happens here, with no write transaction open: the target lookup,
// the refusal rules and the model call. A failure here writes nothing.
export function draftCorrection(
  services: CorrectionServices,
  scope: Scope,
  input: CorrectionInput,
): Promise<Draft> {
  return input.action === 'attach'
    ? draftAttach(services, scope, input.workDisplayId)
    : draftCreate(services, scope, input);
}

type Write = Scope & { unit: CorrectionFacts; now: Date; publishMatcher?: Publish };

// Moves the unit off every label that sits on another work.
async function retractElsewhere(tx: PoolClient, write: Write, threadId: string) {
  for (const label of write.unit.labels) {
    if (label.threadId && label.threadId !== threadId) {
      await retract(
        tx,
        { workspaceId: write.workspaceId, unitId: write.unitId, threadId: label.threadId },
        { opId: label.opId, now: write.now },
      );
    }
  }
}

async function createWork(
  tx: PoolClient,
  write: Write,
  draft: Extract<Draft, { action: 'create' }>,
) {
  refuseIf(correctionRefusal(write.unit, { action: 'create' }));
  await requireActiveCategory(tx, write.workspaceId, draft.categoryId);

  const work = await createFromGenesisInTransaction(
    tx,
    write.workspaceId,
    {
      domainId: draft.categoryId,
      channelId: write.unit.channelId,
      summary: draft.summary,
      confidence: 1,
    },
    write.now,
  );

  if (!work) {
    throw new DomainError('E-INTERNAL');
  }

  await attachGenesisEvidence(tx, write.workspaceId, {
    threadId: work.id,
    messageIds: write.unit.messageIds,
    confidence: 1,
    customerLabel: null,
    nextStep: null,
  });
  await retractElsewhere(tx, write, work.id);
  await persistOperation(
    tx,
    { workspaceId: write.workspaceId, unitId: write.unitId, threadId: work.id },
    {
      type: 'progress',
      tense: 'sudah_terjadi',
      evidenceMessageIds: write.unit.messageIds,
      confidence: 1,
    },
    { now: write.now, publishMatcher: write.publishMatcher },
  );

  return { threadId: work.id, displayId: work.displayId, verdict: 'CREATE' as const };
}

async function attachWork(
  tx: PoolClient,
  write: Write,
  draft: Extract<Draft, { action: 'attach' }>,
) {
  const target = await openTarget(tx, write.workspaceId, draft.target.displayId, write.now);

  if (!target) {
    throw new DomainError(NOT_FOUND);
  }

  refuseIf(correctionRefusal(write.unit, { action: 'attach', target }));
  await retractElsewhere(tx, write, target.id);

  for (const operation of draft.operations) {
    await persistOperation(
      tx,
      { workspaceId: write.workspaceId, unitId: write.unitId, threadId: target.id },
      operation,
      { now: write.now, publishMatcher: write.publishMatcher },
    );
  }

  return { threadId: target.id, displayId: target.displayId, verdict: 'ATTACH' as const };
}

// Writes the correction in the caller's transaction. The unit is locked and the refusal rules are
// checked again, so two identical corrections cannot both pass.
export async function correctUnit(
  tx: PoolClient,
  scope: Scope & { actorId: string },
  draft: Draft,
  options: {
    now: Date;
    previousOutcome: string;
    publishMatcher?: Publish;
  },
) {
  const unit = await lockCorrectionUnit(tx, scope);

  if (!unit) {
    throw new DomainError(NOT_FOUND);
  }

  const write: Write = { ...scope, unit, now: options.now, publishMatcher: options.publishMatcher };
  const written =
    draft.action === 'create'
      ? await createWork(tx, write, draft)
      : await attachWork(tx, write, draft);

  await markAdminResolution(tx, scope, { verdict: written.verdict, threadId: written.threadId });
  await closeOrphan(tx, scope, options.now);
  await closeQuestion(tx, scope, scope.actorId);
  await insertCorrection(tx, scope, {
    action: draft.action,
    threadId: written.threadId,
    previousOutcome: options.previousOutcome,
    actorId: scope.actorId,
    now: options.now,
  });

  return { threadId: written.threadId, displayId: written.displayId };
}
