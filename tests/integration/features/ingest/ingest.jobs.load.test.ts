import { createQueue, publishUnit } from '../../../../src/platform/queue/index.js';
import { Agent, request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
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

test('10x normal throughput for five minutes: all acknowledged messages remain durable (SRS §14)', async () => {
  const baseline = Number(
    (
      await pool.query('SELECT count(*)::int AS count FROM messages_raw WHERE channel_id = $1', [
        channelId,
      ])
    ).rows[0].count,
  );
  const burstMessages = 50 * 10 * 300;
  const server = await listenWebhookApp();
  const agent = new Agent({ keepAlive: true, maxSockets: 500 });

  try {
    const burst = await sendBurst(server.port, agent);

    expect(burst.durationMs).toBeLessThanOrEqual(300000);
    expect(burst.responses).toHaveLength(burstMessages);
    expect(burst.responses.filter((response) => response.status !== 200)).toEqual([]);
    const stored = await pool.query(
      'SELECT count(*)::int AS count FROM messages_raw WHERE channel_id = $1',
      [channelId],
    );

    expect(stored.rows[0].count - baseline).toBe(burstMessages);
  } finally {
    agent.destroy();
    server.server.closeAllConnections();
    await new Promise<void>((resolve) => server.server.close(() => resolve()));
  }
}, 600000);

async function sendBurst(port: number, agent: Agent) {
  const started = Date.now();
  const responses: Array<Promise<{ status: number; body: string }>> = [];

  for (let tick = 0; tick < 3000; tick += 1) {
    const scheduledAt = started + tick * 100;
    const remaining = scheduledAt - Date.now();

    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }

    const second = Math.floor(tick / 10);

    setFixtureNow(new Date(first.getTime() + second * 1000));
    responses.push(
      ...Array.from({ length: 50 }, (_unused, slot) => sendBurstMessage(port, agent, tick, slot)),
    );
  }

  const durationMs = Date.now() - started;

  return { durationMs, responses: await Promise.all(responses) };
}

async function listenWebhookApp() {
  const server = webhookApp.listen(0, '127.0.0.1');

  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const address = server.address() as AddressInfo;

  return { server, port: address.port };
}

async function sendBurstMessage(port: number, agent: Agent, tick: number, slot: number) {
  const second = Math.floor(tick / 10);
  const index = tick * 50 + slot;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1/webhooks/telegram/' + connectionId,
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
        },
      },
      resolve,
    );

    request.once('error', reject);
    request.end(
      JSON.stringify({
        update_id: 1000000 + index,
        message: {
          message_id: 1000000 + index,
          date: first.getTime() / 1000 + second,
          text: 'burst message ' + index,
          from: { id: 700 + (index % 50), is_bot: false },
          chat: { id: chatId, title: 'Burst load group', type: 'supergroup' },
        },
      }),
    );
  });

  const body = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];

    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.once('end', () => resolve(Buffer.concat(chunks).toString()));
  });

  return { status: response.statusCode ?? 0, body };
}
