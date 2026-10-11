import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { selectWork } from './work.repository.js';
import { displayStatus } from './work.rules.js';
import { encodeWorkCursor, type parseWorkQuery } from './work.schema.js';

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
