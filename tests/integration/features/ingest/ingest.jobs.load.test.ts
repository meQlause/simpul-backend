import { createQueue, publishUnit } from '../../../../src/platform/queue/index.js';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
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
import { registerIngestJobs } from '../../../../src/features/ingest/index.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';

let channelId: string;
let connectionId: string;
let workspaceId: string;
let chatId: number;
const first = new Date('2026-10-10T04:04:02Z');

beforeAll(async () => {
  const draft = await draftWithVerification('Burst load group');
  const activation = await request(app)
    .post('/api/v1/channels/' + draft.channelId + '/activate')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'burst-load-active')
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

let queue: Awaited<ReturnType<typeof createQueue>> | undefined;

afterAll(async () => {
  await queue?.stop();
});

test('100 messages in 10 seconds: none lost, all eventually in units (SRS T-14)', async () => {
  const started = Date.now();

  for (let batch = 0; batch < 10; batch += 1) {
    setFixtureNow(new Date(first.getTime() + batch * 1000));
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_unused, slot) => {
        const index = batch * 10 + slot;

        return request(webhookApp)
          .post('/api/v1/webhooks/telegram/' + connectionId)
          .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
          .send({
            update_id: 6000 + index,
            message: {
              message_id: 6000 + index,
              date: first.getTime() / 1000 + batch,
              text: 'load message ' + index,
              from: { id: 605, is_bot: false },
              chat: { id: chatId, title: 'Burst load group', type: 'supergroup' },
            },
          });
      }),
    );

    expect(responses.map((response) => response.status)).toEqual(Array(10).fill(200));
  }

  expect(Date.now() - started).toBeLessThan(10000);
  expect(
    (await pool.query('SELECT id FROM messages_raw WHERE channel_id = $1', [channelId])).rows,
  ).toHaveLength(100);
  queue = await createQueue(pool);
  await pool.query(
    "UPDATE pgboss.job SET start_after = now() WHERE name = 'ingest.coalesce' AND data->>'channelId' = $1",
    [channelId],
  );
  await registerIngestJobs(queue, {
    resolveConnection: createConnectionResolver(pool),
    now: () => new Date(first.getTime() + 21000),
    debounceSeconds: 12,
    publishUnit: publishUnit(queue),
  });
  await vi.waitFor(
    async () => {
      const members = await pool.query(
        'SELECT m.provider_msg_id FROM unit_messages AS member JOIN messages_raw AS m ON m.id = member.message_id WHERE m.channel_id = $1',
        [channelId],
      );

      expect(members.rows.map((row) => row.provider_msg_id).sort()).toEqual(
        Array.from({ length: 100 }, (_unused, index) => String(6000 + index)).sort(),
      );
    },
    { timeout: 10000 },
  );
  expect(
    (await pool.query('SELECT id FROM units WHERE channel_id = $1', [channelId])).rows,
  ).toHaveLength(1);
  expect(
    (
      await pool.query(
        "SELECT id FROM pgboss.job WHERE name = 'understanding.triage' AND data->>'workspaceId' = $1",
        [workspaceId],
      )
    ).rows,
  ).toHaveLength(1);
});
