import express from 'express';
import postgres from 'pg';
import { seedTenantRows } from '../fixtures/tenant-rows.js';
import { webhookRouter } from '../../src/features/ingest/index.js';
import { createConnectionLookup } from '../../src/platform/db/connection-lookup.js';
import { createSecretStore } from '../../src/platform/secrets/index.js';
import {
  createProviderRegistry,
  createTelegramProvider,
} from '../../src/platform/providers/index.js';
import { createQueue, publishCoalesce } from '../../src/platform/queue/index.js';
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
let chatId: number;

beforeAll(async () => {
  const draft = await draftWithVerification('Tenant isolation group');
  const activation = await request(app)
    .post('/api/v1/channels/' + draft.channelId + '/activate')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'tenant-isolation-active')
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
  chatId = Number(row.provider_chat_id);
});

const workspaceB = '00000000-0000-4000-8000-000000000004';
let restricted: postgres.Pool;
let receiver: ReturnType<typeof express>;
let queue: Awaited<ReturnType<typeof createQueue>>;

beforeAll(async () => {
  await seedTenantRows(pool, workspaceB);
  await pool.query(
    "UPDATE channels SET provider_chat_id = '-100888888888', monitored = true, connection_status = 'active', monitoring_started_at = now(), authorization_ack_at = now(), provider_chat_type = 'supergroup', visible_indicator_message_id = 'foreign-indicator' WHERE workspace_id = $1",
    [workspaceB],
  );
  await pool.query('CREATE ROLE ingest_test LOGIN NOSUPERUSER NOBYPASSRLS');
  await pool.query('GRANT USAGE ON SCHEMA public, pgboss TO ingest_test');
  await pool.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, pgboss TO ingest_test',
  );
  const databaseUrl = new URL(pool.options.connectionString!);

  databaseUrl.username = 'ingest_test';
  restricted = new postgres.Pool({ connectionString: databaseUrl.href });
  queue = await createQueue(pool);
  receiver = express()
    .use(
      webhookRouter({
        resolveConnection: createConnectionResolver(restricted),
        lookupConnection: createConnectionLookup(pool),
        secretStore: createSecretStore(Buffer.alloc(32, 7).toString('base64')),
        providers: createProviderRegistry([
          createTelegramProvider('https://telegram.example', fetch),
        ]),
        publish: publishCoalesce(queue),
        now: () => new Date('2026-10-10T04:01:00Z'),
      }),
    )
    .use(errorHandler);
});

afterAll(async () => {
  await queue?.stop();
  await restricted?.end();
});

async function foreignSnapshot() {
  return (
    await pool.query(
      "SELECT (SELECT jsonb_agg(m) FROM messages_raw m WHERE workspace_id = $1) AS messages, (SELECT jsonb_agg(u) FROM units u WHERE workspace_id = $1) AS units, (SELECT jsonb_agg(p) FROM provider_updates p WHERE workspace_id = $1) AS updates, (SELECT jsonb_agg(member) FROM unit_messages member WHERE workspace_id = $1) AS members, (SELECT jsonb_agg(j) FROM pgboss.job j WHERE data->>'workspaceId' = $1::text) AS jobs",
      [workspaceB],
    )
  ).rows;
}

test('REG-007: an update for workspace A’s bot writes nothing in workspace B', async () => {
  const before = await foreignSnapshot();

  for (const [id, targetChatId] of [
    [7001, -100888888888],
    [7002, chatId],
  ]) {
    const response = await request(receiver)
      .post('/api/v1/webhooks/telegram/' + connectionId)
      .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
      .send({
        workspaceId: workspaceB,
        update_id: id,
        message: {
          message_id: id,
          date: 1791604860,
          text: 'workspace-isolated update',
          from: { id: 606, is_bot: false },
          chat: { id: targetChatId, title: 'Tenant isolation group', type: 'supergroup' },
        },
      });

    expect(response.status).toBe(200);
  }

  await coalesce(
    {
      resolveConnection: createConnectionResolver(restricted),
      now: () => new Date('2026-10-10T04:02:00Z'),
      debounceSeconds: 12,
    },
    { workspaceId, channelId, senderExternalId: '606' },
  );
  expect(await foreignSnapshot()).toEqual(before);
  expect(
    (
      await pool.query(
        "SELECT workspace_id, provider_msg_id FROM messages_raw WHERE provider_msg_id IN ('7001', '7002')",
      )
    ).rows,
  ).toEqual([{ workspace_id: workspaceId, provider_msg_id: '7002' }]);
  expect(
    (await pool.query('SELECT workspace_id FROM units WHERE channel_id = $1', [channelId])).rows,
  ).toEqual([{ workspace_id: workspaceId }]);
});
