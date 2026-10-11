import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import type { CredentialProvider } from '../../platform/providers/index.js';
import { storedAccount, selectConnections } from './connections.repository.js';
import type { ConnectionSetup } from './connections-create.service.js';

export async function listConnections(resolveConnection: ConnectionResolver, workspaceId: string) {
  return scopedTransaction(resolveConnection, workspaceId, (tx) =>
    selectConnections(tx, workspaceId),
  );
}

export async function verifyConnection(
  resolveConnection: ConnectionResolver,
  provider: CredentialProvider & Pick<Partial<ConnectionSetup>, 'assertAccountAvailable'>,
  workspaceId: string,
  credential: string,
) {
  const account = await provider.verifyCredential(credential);

  await provider.assertAccountAvailable?.(workspaceId, account.providerAccountId);
  const stored = await scopedTransaction(resolveConnection, workspaceId, (tx) =>
    storedAccount(tx, workspaceId),
  );

  return {
    botUsername: account.botUsername,
    botName: account.botName,
    canJoinGroups: account.canJoinGroups,
    privacyModeOk: account.privacyModeOk,
    sameBotAsStored: stored === undefined ? null : stored === account.providerAccountId,
  };
}
