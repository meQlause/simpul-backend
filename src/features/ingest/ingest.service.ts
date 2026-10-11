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
