import { beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import {
  app,
  cookie,
  pool,
  webhookApp,
  webhookSecret,
  draftWithVerification,
} from '../../../helpers/channel-activation.js';

let connectionId: string;
let chatId: number;
let channelId: string;

beforeAll(async () => {
  const draft = await draftWithVerification('Ingest test group');

  channelId = draft.channelId;
  const activation = await request(app)
    .post('/api/v1/channels/' + channelId + '/activate')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'ingest-active')
    .send({
      verificationId: draft.verificationId,
      authorizationAck: true,
      expectedConfigVersion: 1,
    });

  expect(activation.status).toBe(200);
  const row = (
    await pool.query('SELECT bot_connection_id, provider_chat_id FROM channels WHERE id = $1', [
      channelId,
    ])
  ).rows[0];

  connectionId = row.bot_connection_id;
  chatId = Number(row.provider_chat_id);
});

function deliver(updateId = 901, messageId = 701, targetChatId = chatId) {
  return request(webhookApp)
    .post('/api/v1/webhooks/telegram/' + connectionId)
    .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
    .send({
      update_id: updateId,
      message: {
        message_id: messageId,
        date: 1791604860,
        text: 'buat bu sri tambah 2 dus lagi',
        from: { id: 501, is_bot: false },
        chat: { id: targetChatId, title: 'Ingest test group', type: 'supergroup' },
      },
    });
}

test('The same update_id delivered twice stores one message and enqueues one job (SRS T-02)', async () => {
  const responses = await Promise.all([deliver(), deliver()]);

  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  const messages = await pool.query(
    'SELECT provider_msg_id, body FROM messages_raw WHERE channel_id = $1',
    [channelId],
  );

  expect(messages.rows).toEqual([
    { provider_msg_id: '701', body: 'buat bu sri tambah 2 dus lagi' },
  ]);
  const jobs = await pool.query(
    "SELECT data FROM pgboss.job WHERE name = 'ingest.coalesce' AND data->>'channelId' = $1",
    [channelId],
  );

  expect(jobs.rows).toHaveLength(1);
  expect(jobs.rows[0].data).toEqual({
    workspaceId: (await pool.query('SELECT workspace_id FROM channels WHERE id = $1', [channelId]))
      .rows[0].workspace_id,
    channelId,
    senderExternalId: '501',
  });
});

test('The same message_id in two groups stores two rows (SRS T-30)', async () => {
  const second = await draftWithVerification('Second ingest group');
  const activated = await request(app)
    .post('/api/v1/channels/' + second.channelId + '/activate')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'ingest-second')
    .send({
      verificationId: second.verificationId,
      authorizationAck: true,
      expectedConfigVersion: 1,
    });

  expect(activated.status).toBe(200);
  const secondChatId = Number(
    (await pool.query('SELECT provider_chat_id FROM channels WHERE id = $1', [second.channelId]))
      .rows[0].provider_chat_id,
  );
  const responses = await Promise.all([deliver(902, 702), deliver(903, 702, secondChatId)]);

  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  const rows = await pool.query(
    "SELECT channel_id FROM messages_raw WHERE provider_msg_id = '702' ORDER BY channel_id",
  );

  expect(rows.rows.map((row) => row.channel_id).sort()).toEqual(
    [channelId, second.channelId].sort(),
  );
});
