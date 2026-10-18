import { beforeAll, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { createSecretStore } from '../../../../src/platform/secrets/index.js';
import {
  createProviderRegistry,
  createTelegramProvider,
} from '../../../../src/platform/providers/index.js';
import { receiveUpdate } from '../../../../src/features/ingest/ingest.service.js';
import { createConnectionLookup } from '../../../../src/platform/db/connection-lookup.js';
import { createFakeProvider } from '../../../helpers/providers/fake.js';
import { processMedia } from '../../../../src/features/ingest/ingest.media.service.js';
import { triageUnit } from '../../../../src/features/understanding/understanding.triage.js';

const pool = databaseFixture(3);
const now = new Date('2026-10-10T04:00:00Z');
const seed = pointStarSeed({ now: () => now });
const exchange = vi.fn(async (_payload: unknown) => {});
const downloadVoice = vi.fn(async () => ({ data: new Uint8Array([1, 2]), mimeType: 'audio/ogg' }));
const transcribe = vi.fn(async () => 'ORD-0091 sudah dikirim, rekening 123456789012.');
const publish = vi.fn();
const services = {
  resolveConnection: createConnectionResolver(pool),
  now: () => now,
  secretStore: {
    ...createSecretStore(Buffer.alloc(32, 5).toString('base64')),
    get: vi.fn(async () => 'test-token'),
  },
  providers: createProviderRegistry([
    { ...createFakeProvider(exchange), provider: 'telegram', downloadVoice },
  ]),
  transcriber: { transcribe },
  publishUnit: publish,
  publicBaseUrl: 'https://simpul.example',
};
let channelId: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
  channelId = (
    await pool.query(
      "SELECT id FROM channels WHERE workspace_id = $1 AND class = 'internal' AND monitored AND connection_status = 'active' ORDER BY id LIMIT 1",
      [seed.workspaceId],
    )
  ).rows[0].id;
}, 30000);

async function voiceMessage(providerMsgId: string) {
  return (
    await pool.query(
      `INSERT INTO messages_raw (workspace_id, channel_id, provider_msg_id, sender_external_id, media_ref, server_ts, received_ts)
    VALUES ($1, $2, $3, '605', $4, $5, $5) RETURNING id`,
      [
        seed.workspaceId,
        channelId,
        providerMsgId,
        JSON.stringify({ fileId: 'voice-file', mimeType: 'audio/ogg' }),
        now,
      ],
    )
  ).rows[0].id as string;
}

test('SRS §12.4: a voice note creates one redacted transcript unit at confidenceMultiplier 0.85 under concurrent replay', async () => {
  const messageId = await voiceMessage('voice-success');
  const scope = { workspaceId: seed.workspaceId, messageId };

  await Promise.all([processMedia(services, scope), processMedia(services, scope)]);
  const rows = (
    await pool.query(
      `SELECT u.source, u.confidence_multiplier, u.text, u.explicit_ids FROM units u
    JOIN unit_messages member ON member.unit_id = u.id WHERE member.message_id = $1`,
      [messageId],
    )
  ).rows;

  expect(rows).toEqual([
    {
      source: 'transcript',
      confidence_multiplier: '0.85',
      text: 'ORD-0091 sudah dikirim, rekening [REDACTED].',
      explicit_ids: ['ORD-0091'],
    },
  ]);
  expect(transcribe).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(exchange).not.toHaveBeenCalled();
});

test('SRS §12.4: a voice webhook atomically stores its media reference and queues media without waiting for text coalescing', async () => {
  const connection = (
    await pool.query('SELECT bot_connection_id, provider_chat_id FROM channels WHERE id = $1', [
      channelId,
    ])
  ).rows[0];
  const mediaPublish = vi.fn();
  const textPublish = vi.fn();
  const webhookServices = {
    ...services,
    lookupConnection: createConnectionLookup(pool),
    publish: textPublish,
    publishMedia: mediaPublish,
    providers: createProviderRegistry([createTelegramProvider('https://api.telegram.org')]),
  };
  const update = {
    update_id: 98765,
    message: {
      message_id: 98765,
      date: now.getTime() / 1000,
      from: { id: 605, is_bot: false },
      chat: { id: Number(connection.provider_chat_id), title: 'Warehouse', type: 'supergroup' },
      voice: { file_id: 'voice-webhook', mime_type: 'audio/ogg' },
    },
  };
  const scope = {
    workspaceId: seed.workspaceId,
    connectionId: connection.bot_connection_id,
    provider: 'telegram',
  };

  await receiveUpdate(webhookServices, scope, update);
  await receiveUpdate(webhookServices, scope, update);
  expect(mediaPublish).toHaveBeenCalledTimes(1);
  expect(textPublish).not.toHaveBeenCalled();
  expect(
    (
      await pool.query(
        "SELECT body, media_ref FROM messages_raw WHERE channel_id = $1 AND provider_msg_id = '98765'",
        [channelId],
      )
    ).rows,
  ).toEqual([
    { body: '', media_ref: JSON.stringify({ fileId: 'voice-webhook', mimeType: 'audio/ogg' }) },
  ]);
});

test('SRS §12.4: failed transcription posts the fixed sentence in the group once and creates no unit', async () => {
  transcribe.mockRejectedValueOnce(new Error('unread audio'));
  const messageId = await voiceMessage('voice-failure');
  const scope = { workspaceId: seed.workspaceId, messageId };

  await processMedia(services, scope);
  await processMedia(services, scope);
  expect(
    (await pool.query('SELECT unit_id FROM unit_messages WHERE message_id = $1', [messageId])).rows,
  ).toEqual([]);
  expect(exchange).toHaveBeenCalledTimes(1);
  expect(exchange.mock.calls[0][0]).toMatchObject({
    content: 'The voice note could not be transcribed. Please type the update in this group.',
  });
});

test('SRS §12.4: a transcript follows the normal understanding path using its redacted text rather than empty raw audio', async () => {
  const unitId = (
    await pool.query(
      "SELECT u.id FROM units u JOIN unit_messages member ON member.unit_id = u.id JOIN messages_raw m ON m.id = member.message_id WHERE m.provider_msg_id = 'voice-success'",
      [],
    )
  ).rows[0].id;
  const generate = vi.fn(async () => 'EVENT');
  const publishResolve = vi.fn();

  await triageUnit(
    { ...services, model: { generate }, audit: vi.fn(), publishResolve },
    { workspaceId: seed.workspaceId, unitId },
  );
  expect(generate).toHaveBeenCalledWith(
    expect.objectContaining({ bodySafe: 'ORD-0091 sudah dikirim, rekening [REDACTED].' }),
  );
  expect(publishResolve).toHaveBeenCalledTimes(1);
});

test('FR-TG-13: an unreachable notice throws for the queue, as a refused send did', async () => {
  transcribe.mockRejectedValueOnce(new Error('unread audio'));
  const messageId = await voiceMessage('voice-unreachable');
  const refusing = {
    ...services,
    providers: createProviderRegistry([
      {
        ...createFakeProvider(exchange),
        provider: 'telegram',
        downloadVoice,
        send: async () => ({ unreachable: true }) as never,
      },
    ]),
  };

  await expect(
    processMedia(refusing, { workspaceId: seed.workspaceId, messageId }),
  ).rejects.toMatchObject({ code: 'E-INTERNAL' });
});
