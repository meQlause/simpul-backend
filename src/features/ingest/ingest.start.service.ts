import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { createSecretStore } from '../../platform/secrets/index.js';
import type { createProviderRegistry } from '../../platform/providers/index.js';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { answerStart } from '../people/index.js';

type Services = {
  resolveConnection: ConnectionResolver;
  now: () => Date;
  secretStore: ReturnType<typeof createSecretStore>;
  providers: ReturnType<typeof createProviderRegistry>;
  publicBaseUrl: string;
};

export type StartPayload = {
  workspaceId: string;
  connectionId: string;
  chatId: string;
  senderExternalId: string;
  senderHandle?: string;
  codeHash?: string;
};

// FR-TG-12: link or restart the person, then answer once in their private chat. The reply is a
// courtesy: a refused, rate-limited or failed reply is dropped so the link is never rolled back.
export async function answerStartUpdate(services: Services, payload: StartPayload) {
  await scopedTransaction(services.resolveConnection, payload.workspaceId, async (tx) => {
    const { text, bot } = await answerStart(tx, payload.workspaceId, {
      senderExternalId: payload.senderExternalId,
      senderHandle: payload.senderHandle,
      codeHash: payload.codeHash,
      now: services.now(),
    });

    if (!bot) {
      return;
    }

    const credential = await services.secretStore.get(
      tx,
      payload.workspaceId,
      'bot_token',
      bot.tokenRef,
    );

    await services.providers
      .adapterFor('telegram')
      .send(
        {
          credential,
          providerAccountId: bot.providerAccountId,
          webhookUrl: `${services.publicBaseUrl.replace(/\/$/u, '')}/api/v1/webhooks/telegram/${bot.id}`,
        },
        { kind: 'notice', chatId: payload.chatId, text },
      )
      .catch(() => undefined);
  });
}
