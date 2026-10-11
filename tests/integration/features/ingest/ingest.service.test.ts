import { coalesce } from '../../../../src/features/ingest/index.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { beforeAll, expect, test, vi } from 'vitest';
import request from 'supertest';
import {
  app,
  cookie,
  pool,
  webhookApp,
  webhookSecret,
  draftWithVerification,
} from '../../../helpers/channel-activation.js';

let channelId: string;
let connectionId: string;
let workspaceId: string;
let chatId: number;

beforeAll(async () => {
  const draft = await draftWithVerification('Crash transaction group');
  const activation = await request(app)
    .post('/api/v1/channels/' + draft.channelId + '/activate')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'crash-active')
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

const childSource = `
import postgres from 'pg';
import { receiveUpdate } from './dist/features/ingest/ingest.service.js';
import { createConnectionResolver } from './dist/platform/db/connection-resolver.js';
import { createTelegramProvider } from './dist/platform/providers/index.js';
const pool = new postgres.Pool({connectionString: process.env.CRASH_DATABASE_URL});
const scope = JSON.parse(process.env.CRASH_SCOPE);
await receiveUpdate({
  resolveConnection: createConnectionResolver(pool),
  provider: createTelegramProvider('https://telegram.example', fetch),
  now: () => new Date('2026-10-10T04:01:00Z'),
  publish: async (tx) => {
    const message = await tx.query('SELECT id FROM messages_raw WHERE channel_id = $1', [scope.channelId]);
    process.send({inserted: message.rowCount});
    await new Promise(() => {});
  },
}, scope, JSON.parse(process.env.CRASH_UPDATE));
`;

test('A message and its job commit together: killing the process between them leaves neither', async () => {
  const update = {
    update_id: 4001,
    message: {
      message_id: 4001,
      date: 1791604860,
      text: 'crash-safe update',
      from: { id: 603, is_bot: false },
      chat: { id: chatId, title: 'Crash transaction group', type: 'supergroup' },
    },
  };
  const child = fork('--input-type=module', ['--eval', childSource], {
    env: {
      ...process.env,
      CRASH_DATABASE_URL: pool.options.connectionString,
      CRASH_SCOPE: JSON.stringify({ workspaceId, connectionId, channelId }),
      CRASH_UPDATE: JSON.stringify(update),
    },
    silent: true,
  });

  try {
    const message = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => {
        throw new Error('Child exited before inserting the message');
      }),
    ]);

    expect(message[0]).toEqual({ inserted: 1 });
  } finally {
    const exited = once(child, 'exit');

    child.kill('SIGKILL');
    await exited;
  }

  await vi.waitFor(async () => {
    expect(
      (await pool.query('SELECT id FROM messages_raw WHERE channel_id = $1', [channelId])).rows,
    ).toHaveLength(0);
    expect(
      (
        await pool.query('SELECT update_id FROM provider_updates WHERE bot_connection_id = $1', [
          connectionId,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(
      (await pool.query("SELECT id FROM pgboss.job WHERE data->>'channelId' = $1", [channelId]))
        .rows,
    ).toHaveLength(0);
  });
  const retried = await request(webhookApp)
    .post('/api/v1/webhooks/telegram/' + connectionId)
    .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
    .send(update);

  expect(retried.status).toBe(200);
  expect(
    (await pool.query('SELECT id FROM messages_raw WHERE channel_id = $1', [channelId])).rows,
  ).toHaveLength(1);
  expect(
    (await pool.query("SELECT id FROM pgboss.job WHERE data->>'channelId' = $1", [channelId])).rows,
  ).toHaveLength(1);
});

test('body_safe has NIK, bank-account and card patterns redacted while body is unchanged', async () => {
  const body =
    'NIK 3173010101900001 rekening 1234567890 kartu 4111 1111 1111 1111. ORD-1234567890 tambah 2 dus';
  const safe = 'NIK [REDACTED] rekening [REDACTED] kartu [REDACTED]. ORD-1234567890 tambah 2 dus';
  const response = await request(webhookApp)
    .post('/api/v1/webhooks/telegram/' + connectionId)
    .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
    .send({
      update_id: 5001,
      message: {
        message_id: 5001,
        date: 1791604860,
        text: body,
        from: { id: 604, is_bot: false },
        chat: { id: chatId, title: 'Crash transaction group', type: 'supergroup' },
      },
    });

  expect(response.status).toBe(200);
  expect(
    (
      await pool.query(
        "SELECT body, body_safe FROM messages_raw WHERE channel_id = $1 AND provider_msg_id = '5001'",
        [channelId],
      )
    ).rows,
  ).toEqual([{ body, body_safe: safe }]);
  await coalesce(
    {
      resolveConnection: createConnectionResolver(pool),
      now: () => new Date('2026-10-10T04:02:00Z'),
      debounceSeconds: 12,
    },
    { workspaceId, channelId, senderExternalId: '604' },
  );
  expect(
    (await pool.query('SELECT text FROM units WHERE channel_id = $1', [channelId])).rows,
  ).toEqual([{ text: safe }]);
});
