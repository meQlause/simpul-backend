import {
  claimProviderUpdate,
  connectionProvider,
  connectionTokenRef,
  isOwnBot,
  storeMessage,
  storedMediaId,
} from './ingest.repository.js';
import { receiveRecipientAction } from '../delivery/index.js';
import { answerClarification } from '../understanding/index.js';
import type {
  publishCoalesce,
  publishComprehension,
  publishNotification,
  publishMedia,
  publishStart,
} from '../../platform/queue/index.js';
import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { createConnectionLookup } from '../../platform/db/connection-lookup.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import type { createSecretStore } from '../../platform/secrets/index.js';
import type {
  createProviderRegistry,
  ReceiveProvider,
  InboundMessage,
} from '../../platform/providers/index.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { recordCandidate, recordReceiveCheck } from '../connections/index.js';
import { linkTelegramSender } from '../people/index.js';

const NOT_FOUND = 'E-NOT-FOUND';
const INTERNAL = 'E-INTERNAL';

type PersonStart = Extract<ReturnType<ReceiveProvider['parse']>, { type: 'person-start' }>;

export type WebhookServices = {
  resolveConnection: ConnectionResolver;
  lookupConnection: ReturnType<typeof createConnectionLookup>;
  secretStore: ReturnType<typeof createSecretStore>;
  providers: ReturnType<typeof createProviderRegistry>;
  now: () => Date;
  publish?: ReturnType<typeof publishCoalesce>;
  publishNotification?: ReturnType<typeof publishNotification>;
  publishMedia?: ReturnType<typeof publishMedia>;
  publishComprehend?: ReturnType<typeof publishComprehension>;
  publishStart?: ReturnType<typeof publishStart>;
};

export async function authenticateWebhook(
  services: WebhookServices,
  connectionId: string,
  provider: string,
  request: Parameters<ReceiveProvider['authenticate']>[0],
) {
  const connection = await services.lookupConnection(connectionId);

  if (!connection) {
    throw new DomainError(NOT_FOUND);
  }

  const secret = await scopedTransaction(
    services.resolveConnection,
    connection.workspaceId,
    async (tx) => {
      const storedProvider = await connectionProvider(tx, {
        workspaceId: connection.workspaceId,
        connectionId,
      });

      if (storedProvider !== provider) {
        throw new DomainError(NOT_FOUND);
      }

      return services.secretStore.get(
        tx,
        connection.workspaceId,
        'webhook_secret',
        connection.webhookSecretRef,
      );
    },
  );

  if (!services.providers.adapterFor(provider).authenticate(request, secret)) {
    throw new DomainError('E-WEBHOOK-FORBIDDEN');
  }

  return { workspaceId: connection.workspaceId, connectionId, provider };
}

// The services a button or a reply needs: the update claim, the notification and the answer (FR-RES-02).
function actionServices(
  tx: PoolClient,
  services: WebhookServices,
  scope: { workspaceId: string; connectionId: string },
  input: { updateId: string; now: Date },
) {
  return {
    now: input.now,
    claimUpdate: () => claimProviderUpdate(tx, scope, input.updateId),
    publishNotification: services.publishNotification,
    answerQuestion: (
      answerTx: PoolClient,
      answer: { workspaceId: string; questionId: string; actorId: string; answer: string },
    ) =>
      answerClarification(answerTx, answer, {
        now: input.now,
        publishComprehend: services.publishComprehend,
      }),
  };
}

export async function receiveUpdate(
  services: WebhookServices,
  scope: { workspaceId: string; connectionId: string; provider: string },
  update: unknown,
) {
  const event = services.providers.adapterFor(scope.provider).parse(update);

  if (event.type === 'message') {
    await ingestMessage(services, scope, event);
  }

  if (event.type === 'action') {
    await scopedTransaction(services.resolveConnection, scope.workspaceId, (tx) =>
      receiveRecipientAction(
        tx,
        scope,
        event,
        actionServices(tx, services, scope, { updateId: event.updateId, now: services.now() }),
      ),
    );
    await acknowledgeAction(services, scope, event.receiptId);
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

  if (event.type === 'person-start') {
    await queueStart(services, scope, event);
  }
}

// FR-TG-12: claim the update and queue the Start in one transaction, so a redelivery queues
// nothing. Only the code's hash leaves this function.
async function queueStart(
  services: WebhookServices,
  scope: { workspaceId: string; connectionId: string },
  event: PersonStart,
) {
  await scopedTransaction(services.resolveConnection, scope.workspaceId, async (tx) => {
    if (!(await claimProviderUpdate(tx, scope, event.updateId))) {
      return;
    }

    if (!services.publishStart) {
      throw new DomainError(INTERNAL);
    }

    await services.publishStart(tx, {
      workspaceId: scope.workspaceId,
      connectionId: scope.connectionId,
      chatId: event.chatId,
      senderExternalId: event.senderExternalId,
      ...(event.senderHandle ? { senderHandle: event.senderHandle } : {}),
      ...(event.code ? { codeHash: createHash('sha256').update(event.code).digest('hex') } : {}),
    });
  });
}

async function acknowledgeAction(
  services: WebhookServices,
  scope: { workspaceId: string; connectionId: string; provider: string },
  receiptId: string | undefined,
) {
  const adapter = services.providers.adapterFor(scope.provider);

  if (!receiptId || !adapter.acknowledgeAction) {
    return;
  }

  const credential = await scopedTransaction(
    services.resolveConnection,
    scope.workspaceId,
    async (tx) => {
      const tokenRef = await connectionTokenRef(tx, scope);

      if (!tokenRef) {
        throw new DomainError(NOT_FOUND);
      }

      return services.secretStore.get(tx, scope.workspaceId, 'bot_token', tokenRef);
    },
  );

  await adapter.acknowledgeAction({ credential }, receiptId);
}

async function ingestMessage(
  services: WebhookServices,
  scope: { workspaceId: string; connectionId: string; provider: string },
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

    if (
      await receiveRecipientAction(
        tx,
        scope,
        event,
        actionServices(tx, services, scope, { updateId: event.updateId, now }),
      )
    ) {
      return;
    }

    const channelId = await storeAndLinkSender(tx, scope, event, now);

    if (!channelId) {
      return;
    }

    await enqueueMedia(tx, services, { workspaceId: scope.workspaceId, channelId, event });

    if (!event.body) {
      return;
    }

    if (!services.publish) {
      throw new DomainError(INTERNAL);
    }

    await services.publish(tx, {
      workspaceId: scope.workspaceId,
      channelId,
      senderExternalId: event.senderExternalId,
    });
  });
}

async function enqueueMedia(
  tx: PoolClient,
  services: WebhookServices,
  input: {
    workspaceId: string;
    channelId: string;
    event: InboundMessage;
  },
) {
  if (!input.event.mediaRef) {
    return;
  }

  if (!services.publishMedia) {
    throw new DomainError(INTERNAL);
  }

  const messageId = await storedMediaId(tx, input, input.event.messageId);

  if (messageId) {
    await services.publishMedia(tx, { workspaceId: input.workspaceId, messageId });
  }
}

// Links the sender to the person who holds their username, so the unit built later is theirs (FR-TG-11).
async function storeAndLinkSender(
  tx: PoolClient,
  scope: { workspaceId: string; connectionId: string; provider: string },
  event: Extract<ReturnType<ReceiveProvider['parse']>, { type: 'message' }>,
  now: Date,
) {
  const channelId = await storeMessage(tx, scope, event, now);

  if (channelId && event.senderHandle) {
    await linkTelegramSender(tx, {
      workspaceId: scope.workspaceId,
      provider: scope.provider,
      senderExternalId: event.senderExternalId,
      senderHandle: event.senderHandle,
    });
  }

  return channelId;
}
