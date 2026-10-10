import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import type { CredentialProvider } from '../../platform/providers/index.js';
import { storedAccount } from './connections.repository.js';

export async function verifyConnection(
  resolveConnection: ConnectionResolver,
  provider: CredentialProvider,
  workspaceId: string,
  credential: string,
) {
  const account = await provider.verifyCredential(credential);
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
