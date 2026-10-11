import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { idempotent } from '../../platform/http/idempotency.js';
import type { SetupProvider } from '../../platform/providers/index.js';
import type { createSecretStore } from '../../platform/secrets/index.js';
import { recordConfigChange } from '../audit/index.js';
import { insertConnection } from './connections.repository.js';
import type { parseConnection } from './connections.schema.js';
import type { createAccountClaims } from '../../platform/db/connection-claims.js';

export type ConnectionSetup = Partial<ReturnType<typeof createAccountClaims>> & {
  secretStore: ReturnType<typeof createSecretStore>;
  publicBaseUrl: string;
  now: () => Date;
  newId: () => string;
  newWebhookSecret: () => string;
  newCode: () => string;
};

function connectionSummary(
  id: string,
  connectionName: string,
  account: Awaited<ReturnType<SetupProvider['verifyCredential']>>,
  verifiedAt: Date,
) {
  return {
    id,
    provider: 'telegram',
    connectionName,
    botUsername: account.botUsername,
    botName: account.botName,
    status: account.privacyModeOk ? 'ready' : 'needs_action',
    credentialsPresent: true,
    credentialVersion: 1,
    verifiedAt: verifiedAt.toISOString(),
    webhookCheckedAt: verifiedAt.toISOString(),
    groups: [],
  };
}

export async function createConnection(
  resolveConnection: ConnectionResolver,
  scope: { workspaceId: string; actorId: string },
  request: { input: ReturnType<typeof parseConnection>; key: string },
  services: ConnectionSetup & { provider: SetupProvider },
) {
  let releaseClaim: (() => Promise<void>) | undefined;

  try {
    return await scopedTransaction(resolveConnection, scope.workspaceId, (tx) =>
      idempotent(
        tx,
        {
          workspaceId: scope.workspaceId,
          endpoint: 'POST /telegram/connections',
          key: request.key,
          payload: request.input,
        },
        async () => {
          const { botToken, connectionName } = request.input;
          const account = await services.provider.verifyCredential(botToken);
          const id = services.newId();

          releaseClaim = await services.claimAccount?.({
            workspaceId: scope.workspaceId,
            connectionId: id,
            accountId: account.providerAccountId,
          });
          const verifiedAt = services.now();
          const webhookSecret = services.newWebhookSecret();
          const tokenRef = await services.secretStore.put(tx, scope.workspaceId, {
            purpose: 'bot_token',
            value: botToken,
          });
          const webhookRef = await services.secretStore.put(tx, scope.workspaceId, {
            purpose: 'webhook_secret',
            value: webhookSecret,
          });

          await insertConnection(tx, scope, {
            id,
            connectionName,
            tokenRef,
            webhookRef,
            verifiedAt,
            account,
          });
          const result = connectionSummary(id, connectionName, account, verifiedAt);

          await recordConfigChange(tx, {
            ...scope,
            tableName: 'bot_connections',
            recordId: id,
            before: null,
            after: {
              connectionName,
              providerAccountId: account.providerAccountId,
              status: result.status,
            },
          });
          await services.provider.registerWebhook(
            { credential: botToken },
            `${services.publicBaseUrl.replace(/\/$/u, '')}/api/v1/webhooks/telegram/${id}`,
            webhookSecret,
          );

          return result;
        },
      ),
    );
  } catch (error) {
    await releaseClaim?.();
    throw error;
  }
}
