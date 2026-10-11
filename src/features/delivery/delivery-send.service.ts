import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { createSecretStore } from '../../platform/secrets/index.js';
import type { createProviderRegistry } from '../../platform/providers/index.js';
import {
  lockPendingNotification,
  recordSentAt,
  deferNotification,
  replaceDestination,
} from './delivery-send.repository.js';
import { renderNotification } from './delivery.rules.js';
import { resolveRoleRecipientInTransaction } from '../people/index.js';
import type { PoolClient } from 'pg';
import { DomainError } from '../../platform/errors/domain-error.js';

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

    const chatId = await resolveDestination(tx, scope, pending, now);

    if (!chatId) {
      return;
    }

    const credential = await services.secretStore.get(
      tx,
      scope.workspaceId,
      'bot_token',
      pending.tokenRef,
    );
    const body = renderNotification(pending.body, {
      work_id: pending.work_id,
      customer: pending.customer,
      summary: pending.summary,
    });
    const result = await services.providers.adapterFor(pending.provider).send(
      {
        credential,
        providerAccountId: pending.providerAccountId,
        webhookUrl: `${services.publicBaseUrl.replace(/\/$/u, '')}/api/v1/webhooks/${pending.provider}/${pending.connectionId}`,
      },
      { kind: 'notification', chatId, text: body },
    );

    if ('retryAfter' in result) {
      await deferNotification(tx, scope, { now, retryAfter: result.retryAfter });

      return;
    }

    await recordSentAt(tx, scope, { now, body });
  });
}

async function resolveDestination(
  tx: PoolClient,
  scope: { workspaceId: string; notificationId: string },
  pending: NonNullable<Awaited<ReturnType<typeof lockPendingNotification>>>,
  now: Date,
) {
  if (!pending.roleId) {
    return pending.chatId;
  }

  const recipient = await resolveRoleRecipientInTransaction(
    tx,
    scope.workspaceId,
    pending.roleId,
    pending.originChannelId,
  );
  const chatId = await replaceDestination(tx, scope, {
    personId: recipient.personId ?? null,
    channelId: recipient.channelId ?? null,
    provider: pending.provider,
    now,
  });

  if (chatId === undefined) {
    throw new DomainError('E-INTERNAL');
  }

  return chatId;
}
