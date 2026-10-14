import type { PoolClient } from 'pg';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
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
type Input = ReturnType<typeof parseMessageQuery>;

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
