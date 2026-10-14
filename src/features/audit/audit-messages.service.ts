import type { PoolClient } from 'pg';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import {
  correctUnit,
  draftCorrection,
  type CorrectionInput,
  type CorrectionServices,
} from '../understanding/index.js';
import { recordDecision } from './audit.service.js';
import {
  insertAccessLog,
  messageCounts,
  selectMessages,
  textAccess,
} from './audit-messages.repository.js';
import { messageRow } from './audit-messages.rules.js';
import type { parseMessageQuery } from './audit-messages.schema.js';
import { encodeDecisionCursor } from './audit-read.schema.js';

type Scope = { workspaceId: string; actorId: string };
type Input = ReturnType<typeof parseMessageQuery> & { unitId?: string };

export function listMessages(
  resolveConnection: ConnectionResolver,
  scope: Scope,
  input: Input,
  now: Date,
) {
  return scopedTransaction(resolveConnection, scope.workspaceId, (tx) =>
    readMessages(tx, scope, input, now),
  );
}

// The one place the text-access rule lives: text is selected only while the policy allows it,
// and a read that returns text logs one row per channel it showed.
async function readMessages(tx: PoolClient, scope: Scope, input: Input, now: Date) {
  const allowed = await textAccess(tx, scope.workspaceId);
  const result = await selectMessages(tx, scope.workspaceId, { ...input, text: allowed }, now);
  const rows = result.rows.slice(0, input.limit);
  const last = rows.at(-1);

  if (allowed && rows.length > 0) {
    await insertAccessLog(tx, scope, [...new Set(rows.map((row) => row.channel.id))], now);
  }

  return {
    data: rows.map(messageRow),
    page: {
      total: result.total,
      nextCursor:
        result.rows.length > input.limit && last
          ? encodeDecisionCursor(
              { id: last.unitId, occurredAt: new Date(last.occurredAt) },
              { kind: input.outcome, q: input.q },
            )
          : null,
    },
    counts: await messageCounts(tx, scope.workspaceId, now),
    textAccess: allowed,
  };
}

// The unit's row as it stands, read without logging or returning text.
async function readUnit(tx: PoolClient, scope: Scope & { unitId: string }, now: Date) {
  const rows = await selectMessages(
    tx,
    scope.workspaceId,
    {
      limit: 1,
      text: false,
      unitId: scope.unitId,
      outcome: undefined,
      q: undefined,
      cursor: undefined,
    },
    now,
  );

  return rows.rows[0];
}

export async function correctMessage(
  services: CorrectionServices,
  scope: Scope & { unitId: string },
  input: CorrectionInput,
) {
  const before = await scopedTransaction(services.resolveConnection, scope.workspaceId, (tx) =>
    readUnit(tx, scope, services.now()),
  );

  if (!before) {
    throw new DomainError('E-NOT-FOUND');
  }

  const draft = await draftCorrection(services, scope, input);

  return scopedTransaction(services.resolveConnection, scope.workspaceId, async (tx) => {
    const now = services.now();
    const written = await correctUnit(tx, scope, draft, {
      now,
      previousOutcome: before.outcome,
      publishMatcher: services.publishMatcher,
    });

    await recordDecision(
      tx,
      { workspaceId: scope.workspaceId, threadId: written.threadId, now },
      { displayId: written.displayId, action: 'corrected' },
    );

    const page = await readMessages(
      tx,
      scope,
      { limit: 1, unitId: scope.unitId, outcome: undefined, q: undefined, cursor: undefined },
      now,
    );

    return page.data[0];
  });
}
