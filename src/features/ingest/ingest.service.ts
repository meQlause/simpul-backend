import { isOwnBot, storeMessage } from './ingest.repository.js';
import type { publishCoalesce } from '../../platform/queue/index.js';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { createConnectionLookup } from '../../platform/db/connection-lookup.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import type { createSecretStore } from '../../platform/secrets/index.js';
import type { ReceiveProvider } from '../../platform/providers/index.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordCandidate, recordReceiveCheck } from '../connections/index.js';

export type WebhookServices = {
  resolveConnection: ConnectionResolver;
  lookupConnection: ReturnType<typeof createConnectionLookup>;
  secretStore: ReturnType<typeof createSecretStore>;
  provider: ReceiveProvider;
  now: () => Date;
  publish?: ReturnType<typeof publishCoalesce>;
};

export async function authenticateWebhook(
  services: WebhookServices,
  connectionId: string,
  request: Parameters<ReceiveProvider['authenticate']>[0],
) {
  const connection = await services.lookupConnection(connectionId);

  if (!connection) {
    throw new DomainError('E-NOT-FOUND');
  }

  const secret = await scopedTransaction(services.resolveConnection, connection.workspaceId, (tx) =>
    services.secretStore.get(
      tx,
      connection.workspaceId,
      'webhook_secret',
      connection.webhookSecretRef,
    ),
  );

  if (!services.provider.authenticate(request, secret)) {
    throw new DomainError('E-WEBHOOK-FORBIDDEN');
  }

  return { workspaceId: connection.workspaceId, connectionId };
}

export async function receiveUpdate(
  services: WebhookServices,
  scope: { workspaceId: string; connectionId: string },
  update: unknown,
) {
  const event = services.provider.parse(update);

  if (event.type === 'message') {
    await ingestMessage(services, scope, event);
  }

  if (event.type === 'setup-message') {
    await scopedTransaction(services.resolveConnection, scope.workspaceId, (tx) =>
      recordReceiveCheck(tx, scope, event, services.now()),
    );
  }

  if (event.type === 'setup-command') {
    await scopedTransaction(services.resolveConnection, scope.workspaceId, (tx) =>
      recordCandidate(tx, scope, event, services.now()),
    );
  }
}

async function ingestMessage(
  services: WebhookServices,
  scope: { workspaceId: string; connectionId: string },
  event: Extract<ReturnType<ReceiveProvider['parse']>, { type: 'message' }>,
) {
  const now = services.now();

  await scopedTransaction(services.resolveConnection, scope.workspaceId, async (tx) => {
    if (await isOwnBot(tx, scope, event.senderExternalId)) {
      return;
    }

    if (event.setupProof) {
      await recordReceiveCheck(tx, scope, { chatId: event.chatId, sentAt: event.serverTs }, now);
    }

    const channelId = await storeMessage(tx, scope, event, now);

    if (!channelId) {
      return;
    }

    if (!services.publish) {
      throw new DomainError('E-INTERNAL');
    }

    await services.publish(tx, {
      workspaceId: scope.workspaceId,
      channelId,
      senderExternalId: event.senderExternalId,
    });
  });
}
