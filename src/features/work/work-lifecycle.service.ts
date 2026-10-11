import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { PoolClient } from 'pg';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { archiveRows, reopenRows } from './work-lifecycle.repository.js';

export async function archiveClosed(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
  now: Date,
) {
  return scopedTransaction(resolveConnection, workspaceId, async (tx) => {
    const result = await archiveRows(tx, workspaceId, now);

    return result.rowCount;
  });
}

export async function reopenArchived(
  tx: PoolClient,
  workspaceId: string,
  unitId: string,
  now: Date,
) {
  return reopenRows(tx, workspaceId, unitId, now);
}
