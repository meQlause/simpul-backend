import { beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import {
  app,
  cookie,
  pool,
  webhookApp,
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
  const draft = await draftWithVerification('Loop guard group');
  const activation = await request(app)
    .post('/api/v1/channels/' + draft.channelId + '/activate')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'loop-active')
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
  await pool.query('UPDATE bot_connections SET provider_account_id = $1 WHERE id = $2', [
    '999',
    connectionId,
  ]);
});

test('An update from the workspace’s own bot creates no unit and enqueues nothing (REG-001, SRS T-03)', async () => {
  for (const id of [2001, 2002, 2003]) {
    const response = await request(webhookApp)
      .post('/api/v1/webhooks/telegram/' + connectionId)
      .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
      .send({
        update_id: id,
        message: {
          message_id: id,
          date: 1791604860,
          text: 'Simpul notification',
          from: { id: 999, is_bot: true },
          chat: { id: chatId, title: 'Loop guard group', type: 'supergroup' },
        },
      });

    expect(response.status).toBe(200);
  }

  await coalesce(
    {
      resolveConnection: createConnectionResolver(pool),
      now: () => new Date('2026-10-10T04:02:00Z'),
      debounceSeconds: 12,
    },
    { workspaceId, channelId, senderExternalId: '999' },
  );
  expect(
    (await pool.query('SELECT id FROM messages_raw WHERE channel_id = $1', [channelId])).rows,
  ).toHaveLength(0);
  expect(
    (await pool.query('SELECT id FROM units WHERE channel_id = $1', [channelId])).rows,
  ).toHaveLength(0);
  expect(
    (
      await pool.query('SELECT update_id FROM provider_updates WHERE bot_connection_id = $1', [
        connectionId,
      ])
    ).rows,
  ).toHaveLength(0);
  expect(
    (await pool.query("SELECT id FROM pgboss.job WHERE data->>'channelId' = $1", [channelId])).rows,
  ).toHaveLength(0);
});
