import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import type { PoolClient } from 'pg';
import { recordConfigChange, recordDecision } from '../audit/index.js';
import { cancelWorkNotifications } from '../delivery/index.js';
import { allocateDisplayId } from '../vocabulary/index.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import {
  selectWork,
  insertGenesis,
  selectWorkDetail,
  lockWork,
  storeClosure,
} from './work.repository.js';
import { displayStatus, genesisState, closureStatus, undoAvailable } from './work.rules.js';
import {
  encodeWorkCursor,
  parseGenesis,
  type parseWorkQuery,
  type parseClosure,
} from './work.schema.js';

const NOT_FOUND = 'E-NOT-FOUND';

export async function listWork(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
  input: ReturnType<typeof parseWorkQuery>,
  now: Date,
) {
  return scopedTransaction(resolveConnection, workspaceId, async (tx) => {
    const result = await selectWork(tx, workspaceId, input, now);
    const page = result.rows.slice(0, input.limit);
    const last = page.at(-1);
    const data = page.map(({ id: _id, thresholdHours, ...item }) => ({
      ...item,
      status: displayStatus(
        { status: item.status, lastActivityAt: item.lastActivityAt.getTime() },
        thresholdHours ?? Infinity,
        now.getTime(),
      ),
    }));

    return {
      data,
      page: {
        total: result.total,
        nextCursor: result.rows.length > input.limit && last ? encodeWorkCursor(last, input) : null,
      },
    };
  });
}

export async function createFromGenesis(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
  input: ReturnType<typeof parseGenesis>,
  now: Date,
) {
  const genesis = parseGenesis(input);
  const state = genesisState(genesis.confidence, now.getTime());

  if (!state) {
    return null;
  }

  return scopedTransaction(resolveConnection, workspaceId, async (tx) => {
    const displayId = await allocateDisplayId(tx, workspaceId, genesis.domainId);
    const item = await insertGenesis(tx, workspaceId, genesis, {
      ...state,
      displayId,
      now,
      expiresAt: state.expiresAt === null ? null : new Date(state.expiresAt),
    });

    if (!item) {
      throw new DomainError(NOT_FOUND);
    }

    return item;
  });
}

function workDetail(item: NonNullable<Awaited<ReturnType<typeof selectWorkDetail>>>, now: Date) {
  const status = displayStatus(
    { status: item.status, lastActivityAt: item.lastActivityAt.getTime() },
    item.thresholdHours ?? Infinity,
    now.getTime(),
  );

  return {
    displayId: item.displayId,
    customer: item.customer,
    summary: item.summary,
    status,
    category: item.category,
    channel: item.channel,
    latestUpdate: item.latestUpdate,
    rhythm:
      status === 'stalled'
        ? { typicalHours: item.thresholdHours, reminderCount: item.reminderCount }
        : null,
    owner: item.owner ? { ...item.owner, backupName: item.backupName } : null,
    nextStep: item.nextStep,
    timeline: { identifiedAt: item.createdAt, ruleApplied: item.ruleApplied },
    closure: item.closedAt
      ? {
          kind: item.closureKind,
          reason: item.closureReason,
          closedAt: item.closedAt,
          closedByName: item.closedByName,
        }
      : null,
    canClose: item.status === 'active',
    canUndoClose: undoAvailable({
      status: item.status,
      closedBy: item.closedBy,
      closedAt: item.closedAt?.getTime() ?? null,
      lastActivityAt: item.lastActivityAt.getTime(),
    }),
  };
}

async function detailInTransaction(
  tx: PoolClient,
  workspaceId: string,
  displayId: string,
  now: Date,
) {
  const item = await selectWorkDetail(tx, workspaceId, displayId, now);

  if (!item) {
    throw new DomainError(NOT_FOUND);
  }

  return workDetail(item, now);
}

export async function getWork(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
  displayId: string,
  now: Date,
) {
  return scopedTransaction(resolveConnection, workspaceId, (tx) =>
    detailInTransaction(tx, workspaceId, displayId, now),
  );
}

export async function closeWork(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; actorId: string },
  input: ReturnType<typeof parseClosure> & { displayId: string },
  now: Date,
) {
  return scopedTransaction(resolveConnection, scope.workspaceId, async (tx) => {
    const before = await lockWork(tx, scope.workspaceId, input.displayId, now);

    if (!before) {
      throw new DomainError(NOT_FOUND);
    }

    const updated = await storeClosure(tx, scope, before.id, {
      ...input,
      status: closureStatus(input.closure),
      now,
    });

    if (!updated) {
      throw new DomainError('E-WORK-NOT-OPEN');
    }

    await cancelWorkNotifications(tx, scope.workspaceId, { threadId: before.id, now });
    await recordDecision(
      tx,
      { workspaceId: scope.workspaceId, threadId: before.id, now },
      { displayId: input.displayId, action: input.closure },
    );
    const after = await detailInTransaction(tx, scope.workspaceId, input.displayId, now);

    await recordConfigChange(tx, {
      ...scope,
      tableName: 'threads',
      recordId: before.id,
      before: workDetail(before, now),
      after,
    });

    return after;
  });
}
