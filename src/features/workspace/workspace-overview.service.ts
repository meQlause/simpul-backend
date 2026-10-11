import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { overviewRows } from './workspace-overview.repository.js';

export async function getOverview(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
  period: string,
  now: Date,
) {
  const result = await scopedTransaction(resolveConnection, workspaceId, (tx) =>
    overviewRows(tx, workspaceId, period, now),
  );

  if (!result) {
    throw new DomainError('E-NOT-FOUND');
  }

  return result;
}
