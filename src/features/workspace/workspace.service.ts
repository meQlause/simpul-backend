import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { provisionAdmin } from '../auth/index.js';
import { insertWorkspace, type WorkspaceProvision } from './workspace.repository.js';

export async function createWorkspace(
  resolveConnection: ConnectionResolver,
  provision: WorkspaceProvision,
) {
  await scopedTransaction(resolveConnection, provision.workspaceId, async (tx) => {
    await provisionAdmin(tx, {
      id: provision.authUserId,
      name: provision.input['admin-name'],
      email: provision.input['admin-email'],
      token: provision.token,
      expiresAt: provision.expiresAt,
      now: provision.now,
    });
    await insertWorkspace(tx, provision);
  });
}
