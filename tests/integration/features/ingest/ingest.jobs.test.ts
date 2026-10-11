import { createQueue, publishUnit } from '../../../../src/platform/queue/index.js';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
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
import { coalesce, registerIngestJobs } from '../../../../src/features/ingest/index.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';

let scope: { workspaceId: string; channelId: string; senderExternalId: string };
let connectionId: string;
let chatId: number;
let queue: Awaited<ReturnType<typeof createQueue>> | undefined;

afterAll(async () => {
  await queue?.stop();
});
const receivedAt = new Date('2026-10-10T04:01:00Z');

afterEach(() => setFixtureNow(receivedAt));

beforeAll(async () => {
  const draft = await draftWithVerification('Coalescing group');
  const activation = await request(app)
    .post('/api/v1/channels/' + draft.channelId + '/activate')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'coalesce-active')
    .send({
      verificationId: draft.verificationId,
      authorizationAck: true,
      expectedConfigVersion: 1,
    });

  expect(activation.status).toBe(200);
  const row = (
    await pool.query(
      'SELECT workspace_id, bot_connection_id, provider_chat_id FROM channels WHERE id = $1',
      [draft.channelId],
    )
  ).rows[0];

  scope = { workspaceId: row.workspace_id, channelId: draft.channelId, senderExternalId: '601' };
  connectionId = row.bot_connection_id;
  chatId = Number(row.provider_chat_id);
});

async function deliver(offset: number) {
  const response = await request(webhookApp)
    .post('/api/v1/webhooks/telegram/' + connectionId)
    .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
    .send({
      update_id: 1000 + offset,
      message: {
        message_id: 800 + offset,
        date: receivedAt.getTime() / 1000 + offset,
        text: 'part ' + offset,
        from: { id: 601, is_bot: false },
        chat: { id: chatId, title: 'Coalescing group', type: 'supergroup' },
      },
    });

  expect(response.status).toBe(200);
}

test('Six messages from one sender within 10 seconds become one unit ordered by server_ts (SRS T-01)', async () => {
  for (const offset of [10, 0, 8, 2, 6, 4]) {
    setFixtureNow(new Date(receivedAt.getTime() + (offset === 4 ? 10000 : 0)));
    await deliver(offset);
  }

  const services = {
    resolveConnection: createConnectionResolver(pool),
    now: () => new Date(receivedAt.getTime() + 21000),
    debounceSeconds: 12,
  };

  await coalesce(services, scope);
  expect(
    (await pool.query('SELECT id FROM units WHERE channel_id = $1', [scope.channelId])).rows,
  ).toHaveLength(0);
  services.now = () => new Date(receivedAt.getTime() + 22000);
  await Promise.all([coalesce(services, scope), coalesce(services, scope)]);
  const units = await pool.query(
    'SELECT id, text, ts_first, ts_last FROM units WHERE channel_id = $1',
    [scope.channelId],
  );

  expect(units.rows).toHaveLength(1);
  expect(units.rows[0]).toMatchObject({
    text: 'part 0 part 2 part 4 part 6 part 8 part 10',
    ts_first: receivedAt,
    ts_last: new Date(receivedAt.getTime() + 10000),
  });
  const members = await pool.query(
    'SELECT member.workspace_id, m.provider_msg_id FROM unit_messages AS member JOIN messages_raw AS m ON m.id = member.message_id WHERE member.unit_id = $1 ORDER BY m.server_ts',
    [units.rows[0].id],
  );

  expect(members.rows).toEqual(
    ['800', '802', '804', '806', '808', '810'].map((providerMsgId) => ({
      workspace_id: scope.workspaceId,
      provider_msg_id: providerMsgId,
    })),
  );
  await coalesce(services, scope);
  expect(
    (await pool.query('SELECT id FROM units WHERE channel_id = $1', [scope.channelId])).rows,
  ).toHaveLength(1);
});

test('The coalescing worker consumes persisted jobs and publishes one ids-only triage job', async () => {
  for (const offset of [30, 20, 28, 22, 26, 24]) {
    await deliver(offset);
  }

  queue = await createQueue(pool);
  await pool.query(
    "UPDATE pgboss.job SET start_after = now() WHERE name = 'ingest.coalesce' AND data->>'channelId' = $1",
    [scope.channelId],
  );
  await registerIngestJobs(queue, {
    resolveConnection: createConnectionResolver(pool),
    now: () => new Date(receivedAt.getTime() + 12000),
    debounceSeconds: 12,
    publishUnit: publishUnit(queue),
  });
  await vi.waitFor(
    async () => {
      const units = await pool.query(
        'SELECT text FROM units WHERE channel_id = $1 ORDER BY ts_first',
        [scope.channelId],
      );

      expect(units.rows.map((row) => row.text)).toEqual([
        'part 0 part 2 part 4 part 6 part 8 part 10',
        'part 20 part 22 part 24 part 26 part 28 part 30',
      ]);
    },
    { timeout: 10000 },
  );
  const jobs = await pool.query("SELECT data FROM pgboss.job WHERE name = 'understanding.triage'");
  const unit = (
    await pool.query('SELECT id FROM units WHERE channel_id = $1 ORDER BY ts_first DESC LIMIT 1', [
      scope.channelId,
    ])
  ).rows[0];

  expect(jobs.rows).toEqual([{ data: { workspaceId: scope.workspaceId, unitId: unit.id } }]);
});
