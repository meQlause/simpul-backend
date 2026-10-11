import { beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import {
  app,
  cookie,
  pool,
  webhookApp,
  webhookSecret,
  draftWithVerification,
  setFixtureNow,
} from '../../../helpers/channel-activation.js';
import { coalesce } from '../../../../src/features/ingest/index.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';

let channelId: string;
let connectionId: string;
let workspaceId: string;
let chatId: number;
const first = new Date('2026-10-10T04:04:02Z');

beforeAll(async () => {
  const draft = await draftWithVerification('SRS worked example');
  const activation = await request(app)
    .post('/api/v1/channels/' + draft.channelId + '/activate')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'srs-example-active')
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

test('The SRS §5.4 example — four payloads, one a duplicate — yields one unit with three message ids and the text "buat bu sri tambah 2 dus lagi ya yg kemarin blm dikirim kan?"', async () => {
  const messages = [
    { id: 899, offset: 0, text: 'buat bu sri' },
    { id: 900, offset: 9, text: 'tambah 2 dus lagi ya' },
    { id: 901, offset: 17, text: 'yg kemarin blm dikirim kan?' },
    { id: 899, offset: 0, text: 'buat bu sri' },
  ];

  for (const message of messages) {
    setFixtureNow(new Date(first.getTime() + message.offset * 1000));
    const response = await request(webhookApp)
      .post('/api/v1/webhooks/telegram/' + connectionId)
      .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
      .send({
        update_id: message.id,
        message: {
          message_id: message.id,
          date: first.getTime() / 1000 + message.offset,
          text: message.text,
          from: { id: 602, is_bot: false },
          chat: { id: chatId, title: 'SRS worked example', type: 'supergroup' },
        },
      });

    expect(response.status).toBe(200);
  }

  await coalesce(
    {
      resolveConnection: createConnectionResolver(pool),
      now: () => new Date(first.getTime() + 29000),
      debounceSeconds: 12,
    },
    { workspaceId, channelId, senderExternalId: '602' },
  );
  const units = await pool.query(
    'SELECT id, text, ts_first, ts_last FROM units WHERE channel_id = $1',
    [channelId],
  );

  expect(units.rows).toHaveLength(1);
  expect(units.rows[0]).toMatchObject({
    text: 'buat bu sri tambah 2 dus lagi ya yg kemarin blm dikirim kan?',
    ts_first: first,
    ts_last: new Date(first.getTime() + 17000),
  });
  const members = await pool.query(
    'SELECT m.provider_msg_id FROM unit_messages AS member JOIN messages_raw AS m ON m.id = member.message_id WHERE member.unit_id = $1 ORDER BY m.server_ts',
    [units.rows[0].id],
  );

  expect(members.rows.map((row) => row.provider_msg_id)).toEqual(['899', '900', '901']);
  expect(
    (await pool.query('SELECT id FROM messages_raw WHERE channel_id = $1', [channelId])).rows,
  ).toHaveLength(3);
});
