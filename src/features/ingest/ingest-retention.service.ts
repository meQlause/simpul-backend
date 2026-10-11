import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { deleteOldMessages } from './ingest-retention.repository.js';

export async function retainMessages(resolver: ConnectionResolver, workspaceId: string, now: Date) {
  return scopedTransaction(resolver, workspaceId, (tx) => deleteOldMessages(tx, workspaceId, now));
}
