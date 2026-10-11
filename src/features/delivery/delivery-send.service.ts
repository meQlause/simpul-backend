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
import { renderNotification, renderActions } from './delivery.rules.js';
import { resolveRoleRecipientInTransaction } from '../people/index.js';
import type { PoolClient } from 'pg';
import { DomainError } from '../../platform/errors/domain-error.js';

type Services = {
  resolveConnection: ConnectionResolver;
  now: () => Date;
  secretStore: ReturnType<typeof createSecretStore>;
  providers: ReturnType<typeof createProviderRegistry>;
  publicBaseUrl: string;
  publishNotification?: (
    tx: PoolClient,
    payload: { workspaceId: string; notificationId: string },
    heldUntil: Date,
  ) => Promise<unknown>;
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
    const message = outboundMessage(services, scope, pending, chatId);
    const result = await services.providers.adapterFor(pending.provider).send(
      {
        credential,
        providerAccountId: pending.providerAccountId,
        webhookUrl: `${services.publicBaseUrl.replace(/\/$/u, '')}/api/v1/webhooks/${pending.provider}/${pending.connectionId}`,
      },
      message,
    );

    if ('retryAfter' in result) {
      await retryNotification(tx, services, scope, { now, retryAfter: result.retryAfter });

      return;
    }

    await recordSentAt(tx, scope, { now, body: message.text });
  });
}

async function retryNotification(
  tx: PoolClient,
  services: Services,
  scope: { workspaceId: string; notificationId: string },
  input: { now: Date; retryAfter: number },
) {
  const millisecondsPerSecond = 1000;

  await deferNotification(tx, scope, input);
  await services.publishNotification?.(
    tx,
    scope,
    new Date(input.now.getTime() + input.retryAfter * millisecondsPerSecond),
  );
}

function outboundMessage(
  services: Services,
  scope: { notificationId: string },
  pending: NonNullable<Awaited<ReturnType<typeof lockPendingNotification>>>,
  chatId: string,
) {
  const body = renderNotification(pending.body, {
    work_id: pending.work_id,
    customer: pending.customer,
    summary: pending.summary,
  });
  const actions =
    pending.kind === 'correction'
      ? []
      : [
          { id: `n:${scope.notificationId}:r`, label: 'Already shipped' },
          { id: `n:${scope.notificationId}:p`, label: 'In progress' },
          { id: `n:${scope.notificationId}:b`, label: 'There is a blocker' },
          { id: `n:${scope.notificationId}:x`, label: 'Not this work' },
        ];
  const rendered = renderActions(
    actions,
    services.providers.adapterFor(pending.provider).capabilities,
  );

  return {
    kind: pending.kind,
    chatId,
    text: [body, rendered.text].filter(Boolean).join('\n'),
    actions: rendered.actions,
  };
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
