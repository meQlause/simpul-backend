import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { createSecretStore } from '../../platform/secrets/index.js';
import type { createProviderRegistry } from '../../platform/providers/index.js';
import {
  lockPendingNotification,
  recordSentAt,
  deferNotification,
} from './delivery-send.repository.js';

type Services = {
  resolveConnection: ConnectionResolver;
  now: () => Date;
  secretStore: ReturnType<typeof createSecretStore>;
  providers: ReturnType<typeof createProviderRegistry>;
  publicBaseUrl: string;
};

export async function sendNotification(
  services: Services,
  scope: { workspaceId: string; notificationId: string },
) {
  return scopedTransaction(services.resolveConnection, scope.workspaceId, async (tx) => {
    const now = services.now();
    const pending = await lockPendingNotification(tx, scope, now);

    if (!pending) {
      return;
    }

    const credential = await services.secretStore.get(
      tx,
      scope.workspaceId,
      'bot_token',
      pending.tokenRef,
    );
    const result = await services.providers.adapterFor(pending.provider).send(
      {
        credential,
        providerAccountId: pending.providerAccountId,
        webhookUrl: `${services.publicBaseUrl.replace(/\/$/u, '')}/api/v1/webhooks/${pending.provider}/${pending.connectionId}`,
      },
      { kind: 'notification', chatId: pending.chatId, text: pending.body },
    );

    if ('retryAfter' in result) {
      await deferNotification(tx, scope, { now, retryAfter: result.retryAfter });

      return;
    }

    await recordSentAt(tx, scope, now);
  });
}
