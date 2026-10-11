import { createQueue, publishCoalesce, publishUnit } from '../../src/platform/queue/index.js';
import express from 'express';
import { createFakeProvider } from '../helpers/providers/fake.js';
import {
  createProviderRegistry,
  createTelegramProvider,
} from '../../src/platform/providers/index.js';
import { createConnectionLookup } from '../../src/platform/db/connection-lookup.js';
import { createSecretStore } from '../../src/platform/secrets/index.js';
import { webhookRouter } from '../../src/features/ingest/index.js';
import { errorHandler } from '../../src/platform/http/error-handler.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import {
  app,
  cookie,
  pool,
  webhookSecret,
  draftWithVerification,
} from '../helpers/channel-activation.js';
import { coalesce } from '../../src/features/ingest/index.js';
import { createConnectionResolver } from '../../src/platform/db/connection-resolver.js';

let channelId: string;
let connectionId: string;
let workspaceId: string;

beforeAll(async () => {
  const draft = await draftWithVerification('Fake provider group');
  const activation = await request(app)
    .post('/api/v1/channels/' + draft.channelId + '/activate')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'fake-provider-active')
    .send({
      verificationId: draft.verificationId,
      authorizationAck: true,
      expectedConfigVersion: 1,
    });

  expect(activation.status).toBe(200);
  channelId = draft.channelId;
  const row = (
    await pool.query(
      'SELECT workspace_id, bot_connection_id, provider_chat_id FROM channels WHERE id = $1',
      [channelId],
    )
  ).rows[0];

  workspaceId = row.workspace_id;
  connectionId = row.bot_connection_id;
});

let receiver: ReturnType<typeof express>;
let queue: Awaited<ReturnType<typeof createQueue>>;

afterAll(async () => {
  await queue?.stop();
});
const fake = createFakeProvider(async () => {});

beforeAll(async () => {
  await pool.query('ALTER TABLE bot_connections DROP CONSTRAINT bot_provider_valid');
  await pool.query(
    "ALTER TABLE bot_connections ADD CONSTRAINT bot_provider_valid CHECK (provider IN ('telegram', 'fake'))",
  );
  await pool.query('ALTER TABLE channels DROP CONSTRAINT channels_provider_valid');
  await pool.query(
    "ALTER TABLE channels ADD CONSTRAINT channels_provider_valid CHECK (provider IN ('telegram', 'fake'))",
  );
  await pool.query(
    "UPDATE bot_connections SET provider = 'fake', provider_account_id = 'fake-account' WHERE id = $1",
    [connectionId],
  );
  await pool.query(
    "UPDATE channels SET provider = 'fake', provider_chat_id = 'room-alpha' WHERE id = $1",
    [channelId],
  );
  const providers = createProviderRegistry();

  providers.register(createTelegramProvider('https://telegram.example', fetch));
  providers.register(fake);
  queue = await createQueue(pool);
  receiver = express()
    .use(
      webhookRouter({
        resolveConnection: createConnectionResolver(pool),
        lookupConnection: createConnectionLookup(pool),
        secretStore: createSecretStore(Buffer.alloc(32, 7).toString('base64')),
        providers,
        now: () => new Date('2026-10-10T04:01:00Z'),
        publish: publishCoalesce(queue),
      }),
    )
    .use(errorHandler);
});

test('REG-010: the shared registry webhook stores and coalesces a fake-provider update', async () => {
  const response = await request(receiver)
    .post('/api/v1/webhooks/fake/' + connectionId)
    .set('X-Fake-Secret', webhookSecret)
    .send({
      eventId: 'evt-alpha',
      room: 'room-alpha',
      messageId: 'msg-alpha',
      author: 'person-alpha',
      content: 'Provider-neutral message',
      sentAt: 1791604860000,
    });

  expect(response.status).toBe(200);
  expect(
    (
      await pool.query(
        'SELECT provider_msg_id, sender_external_id, body FROM messages_raw WHERE channel_id = $1',
        [channelId],
      )
    ).rows,
  ).toEqual([
    {
      provider_msg_id: 'msg-alpha',
      sender_external_id: 'person-alpha',
      body: 'Provider-neutral message',
    },
  ]);
  await coalesce(
    {
      resolveConnection: createConnectionResolver(pool),
      now: () => new Date('2026-10-10T04:02:00Z'),
      debounceSeconds: 12,
      publishUnit: publishUnit(queue),
    },
    { workspaceId, channelId, senderExternalId: 'person-alpha' },
  );
  expect(
    (await pool.query('SELECT text FROM units WHERE channel_id = $1', [channelId])).rows,
  ).toEqual([{ text: 'Provider-neutral message' }]);
  expect(
    (await pool.query("SELECT data FROM pgboss.job WHERE name = 'ingest.coalesce'")).rows,
  ).toEqual([{ data: { workspaceId, channelId, senderExternalId: 'person-alpha' } }]);
  expect(
    (await pool.query("SELECT id FROM pgboss.job WHERE name = 'understanding.triage'")).rows,
  ).toHaveLength(1);
  expect(fake.capabilities).toMatchObject({ replyTo: false, inlineActions: false });
});

test('A mismatched or unregistered provider is rejected before its body is parsed', async () => {
  for (const provider of ['telegram', 'unregistered']) {
    const response = await request(receiver)
      .post('/api/v1/webhooks/' + provider + '/' + connectionId)
      .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
      .set('Content-Type', 'application/json')
      .send('{invalid');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('E-NOT-FOUND');
  }
});

test('A fake-provider request with the wrong secret is rejected before body parsing', async () => {
  const response = await request(receiver)
    .post('/api/v1/webhooks/fake/' + connectionId)
    .set('X-Fake-Secret', 'wrong')
    .set('Content-Type', 'application/json')
    .send('{invalid');

  expect(response.status).toBe(403);
  expect(response.body.error.code).toBe('E-WEBHOOK-FORBIDDEN');
});
