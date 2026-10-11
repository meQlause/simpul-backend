import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { ruleRows } from './rules.repository.js';

export function listRules(resolveConnection: ConnectionResolver, workspaceId: string, now: Date) {
  return scopedTransaction(resolveConnection, workspaceId, (tx) => ruleRows(tx, workspaceId, now));
}
