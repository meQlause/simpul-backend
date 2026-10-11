import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { createSecretStore } from '../../platform/secrets/index.js';
import type { createProviderRegistry } from '../../platform/providers/index.js';
import type { publishUnit } from '../../platform/queue/index.js';
import type { PoolClient } from 'pg';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { lockMedia, storeTranscript, recordMediaOutcome } from './ingest.media.repository.js';
import { redactPii } from './ingest.rules.js';

type Services = {
  resolveConnection: ConnectionResolver;
  secretStore: ReturnType<typeof createSecretStore>;
  providers: ReturnType<typeof createProviderRegistry>;
  now: () => Date;
  publicBaseUrl: string;
  transcriber: { transcribe: (audio: { data: Uint8Array; mimeType: string }) => Promise<string> };
  publishUnit?: ReturnType<typeof publishUnit>;
};

export async function processMedia(
  services: Services,
  scope: { workspaceId: string; messageId: string },
) {
  return scopedTransaction(services.resolveConnection, scope.workspaceId, async (tx) => {
    const media = await lockMedia(tx, scope);

    if (!media) {
      return;
    }

    const credential = await services.secretStore.get(
      tx,
      scope.workspaceId,
      'bot_token',
      media.tokenRef,
    );
    const connection = {
      credential,
      providerAccountId: media.providerAccountId,
      webhookUrl: `${services.publicBaseUrl.replace(/\/$/u, '')}/api/v1/webhooks/${media.provider}/${media.connectionId}`,
    };
    const adapter = services.providers.adapterFor(media.provider);
    const transcript = await transcribeVoice(services, {
      adapter,
      connection,
      mediaRef: media.mediaRef,
    });

    if (!transcript) {
      const result = await adapter.send(connection, {
        kind: 'notice',
        chatId: media.chatId,
        text: 'The voice note could not be transcribed. Please type the update in this group.',
      });

      if ('retryAfter' in result) {
        throw new DomainError('E-INTERNAL', undefined, result.retryAfter);
      }

      await recordMediaOutcome(tx, scope, 'unread');

      return;
    }

    await saveTranscript(tx, services, scope, transcript);
  });
}

async function transcribeVoice(
  services: Services,
  input: {
    adapter: ReturnType<Services['providers']['adapterFor']>;
    connection: { credential: string; providerAccountId: string; webhookUrl: string };
    mediaRef: string;
  },
) {
  try {
    const audio = await input.adapter.downloadVoice?.(input.connection, input.mediaRef);

    return audio ? (await services.transcriber.transcribe(audio)).trim() : '';
  } catch {
    return '';
  }
}

async function saveTranscript(
  tx: PoolClient,
  services: Services,
  scope: { workspaceId: string; messageId: string },
  transcript: string,
) {
  const unitId = await storeTranscript(tx, scope, redactPii(transcript));

  await recordMediaOutcome(tx, scope, 'transcript');
  await services.publishUnit?.(tx, { workspaceId: scope.workspaceId, unitId });
}
