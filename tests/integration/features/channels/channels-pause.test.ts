import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import request from 'supertest';
import {
  app,
  webhookApp,
  webhookSecret,
  cookie,
  pool,
  provider,
  draftWithVerification,
} from '../../../helpers/channel-activation.js';

async function activeGroup(name: string) {
  const draft = await draftWithVerification(name);
  const response = await request(app)
    .post(`/api/v1/channels/${draft.channelId}/activate`)
    .set('Cookie', cookie)
    .set('Idempotency-Key', name)
    .send({
      verificationId: draft.verificationId,
      authorizationAck: true,
      expectedConfigVersion: 1,
    });

  expect(response.status).toBe(200);

  return draft.channelId;
}

async function notification(channelId: string, state: 'held' | 'sent' | 'cancelled') {
  const id = randomUUID();

  await pool.query(
    `WITH message AS (INSERT INTO messages_raw (id, workspace_id, channel_id, provider_msg_id, sender_external_id, body, body_safe, server_ts, received_ts)
    SELECT $2::uuid, workspace_id, id, $2::uuid::text, 'test-sender', 'Test evidence', 'Test evidence', '2026-10-10T04:00:00Z', '2026-10-10T04:00:00Z' FROM channels WHERE id = $1 RETURNING id, workspace_id, channel_id),
    unit_row AS (INSERT INTO units (id, workspace_id, channel_id, text, ts_first, ts_last)
    SELECT $3, workspace_id, channel_id, 'Test evidence', '2026-10-10T04:00:00Z', '2026-10-10T04:00:00Z' FROM message RETURNING id, workspace_id),
    label AS (INSERT INTO labels (id, workspace_id, unit_id, type, tense, evidence_message_ids, confidence, vocab_version)
    SELECT $4, workspace_id, id, 'progress', 'sudah_terjadi', ARRAY[$2::uuid], 1, 1 FROM unit_row RETURNING id, workspace_id)
    INSERT INTO notifications (id, workspace_id, label_id, recipient_person_id, channel, body_rendered, held_until, sent_at, cancelled_at)
    SELECT $5, workspace_id, id, md5('point-star-person-1')::uuid, 'telegram', 'Test notification', '2026-10-10T04:02:00Z',
    CASE WHEN $6 = 'sent' THEN '2026-10-10T04:00:00Z'::timestamptz END,
    CASE WHEN $6 = 'cancelled' THEN '2026-10-10T04:00:00Z'::timestamptz END FROM label`,
    [channelId, randomUUID(), randomUUID(), randomUUID(), id, state],
  );

  return id;
}

async function assertOnlyUnsentCancelled(ids: {
  held: string;
  sent: string;
  cancelled: string;
  other: string;
}) {
  const rows = (await pool.query('SELECT id, sent_at, cancelled_at FROM notifications ORDER BY id'))
    .rows;

  expect(rows.find((row) => row.id === ids.held)).toMatchObject({
    sent_at: null,
    cancelled_at: new Date('2026-10-10T04:01:00Z'),
  });
  expect(rows.find((row) => row.id === ids.sent)).toMatchObject({
    sent_at: new Date('2026-10-10T04:00:00Z'),
    cancelled_at: null,
  });
  expect(rows.find((row) => row.id === ids.cancelled)).toMatchObject({
    sent_at: null,
    cancelled_at: new Date('2026-10-10T04:00:00Z'),
  });
  expect(rows.find((row) => row.id === ids.other)).toMatchObject({
    sent_at: null,
    cancelled_at: null,
  });
}

async function assertPausedWebhookDrops(channelId: string) {
  const group = (
    await pool.query('SELECT bot_connection_id, provider_chat_id FROM channels WHERE id = $1', [
      channelId,
    ])
  ).rows[0];
  const count = (await pool.query('SELECT count(*)::int AS count FROM messages_raw')).rows[0].count;
  const response = await request(webhookApp)
    .post(`/api/v1/webhooks/telegram/${group.bot_connection_id}`)
    .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
    .send({
      update_id: 999,
      message: {
        message_id: 999,
        text: 'A new ordinary message',
        chat: { id: Number(group.provider_chat_id), type: 'supergroup', title: 'Paused group' },
      },
    });

  expect(response.status).toBe(200);
  expect((await pool.query('SELECT count(*)::int AS count FROM messages_raw')).rows[0].count).toBe(
    count,
  );
}

test('SRS T-23: pausing one of two channels leaves the other active and the shared webhook in place; only unsent notifications of the paused group are cancelled', async () => {
  const [first, second] = await Promise.all([
    activeGroup('pause-first'),
    activeGroup('pause-second'),
  ]);
  const bot = (await pool.query('SELECT * FROM bot_connections')).rows;
  const other = (await pool.query('SELECT * FROM channels WHERE id = $1', [second])).rows;
  const ids = {
    held: await notification(first, 'held'),
    sent: await notification(first, 'sent'),
    cancelled: await notification(first, 'cancelled'),
    other: await notification(second, 'held'),
  };
  const response = await request(app)
    .post(`/api/v1/channels/${first}/pause`)
    .set('Cookie', cookie)
    .send({ expectedConfigVersion: 1 });

  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    id: first,
    connectionStatus: 'paused',
    monitored: false,
    configVersion: 2,
  });
  expect((await pool.query('SELECT * FROM channels WHERE id = $1', [second])).rows).toEqual(other);
  expect(other[0]).toMatchObject({ connection_status: 'active', monitored: true });
  expect((await pool.query('SELECT * FROM bot_connections')).rows).toEqual(bot);
  expect(provider.registerWebhook).not.toHaveBeenCalled();
  expect(provider.send).toHaveBeenCalledTimes(2);
  await assertOnlyUnsentCancelled(ids);
  await assertPausedWebhookDrops(first);
});

test('Channels §7: pausing with a stale version changes neither channels nor notifications', async () => {
  const group = (await pool.query("SELECT id FROM channels WHERE connection_status = 'active'"))
    .rows[0];
  const before = (await pool.query('SELECT * FROM channels ORDER BY id')).rows;
  const pending = (await pool.query('SELECT * FROM notifications ORDER BY id')).rows;
  const response = await request(app)
    .post(`/api/v1/channels/${group.id}/pause`)
    .set('Cookie', cookie)
    .send({ expectedConfigVersion: 99 });

  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('E-TG-VERSION-CONFLICT');
  expect((await pool.query('SELECT * FROM channels ORDER BY id')).rows).toEqual(before);
  expect((await pool.query('SELECT * FROM notifications ORDER BY id')).rows).toEqual(pending);
});
