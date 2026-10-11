import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import {
  lockWorkspace,
  checkErasureInventory,
  lockTenantRows,
  eraseAuth,
  eraseTenantRows,
  eraseJobs,
} from '../../platform/db/workspace-erasure.js';
import { guardForeignReferences } from '../../platform/db/workspace-erasure-guard.js';

export async function eraseWorkspace(resolver: ConnectionResolver, workspaceId: string) {
  return scopedTransaction(resolver, workspaceId, async (tx) => {
    if (!(await lockWorkspace(tx, workspaceId))) {
      return false;
    }

    await checkErasureInventory(tx);
    await lockTenantRows(tx, workspaceId);
    await guardForeignReferences(tx, workspaceId);
    await eraseJobs(tx, workspaceId);
    await eraseAuth(tx, workspaceId);
    await eraseTenantRows(tx, workspaceId);

    return true;
  });
}
