import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../../../../src/app.js';
import { signInSeedAdmin } from '../../../helpers/admin-session.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { createConnectionLookup } from '../../../../src/platform/db/connection-lookup.js';
import { createSecretStore } from '../../../../src/platform/secrets/index.js';
import { createTelegramProvider } from '../../../../src/platform/providers/index.js';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';

const pool = databaseFixture(2);
const token = 'test-only-shared-bot-token';
const provider = {
  verifyCredential: vi.fn(async () => ({
    providerAccountId: 'shared-test-bot',
    botUsername: 'test_bot',
    botName: 'Test bot',
    canJoinGroups: true,
    privacyModeOk: true,
  })),
  registerWebhook: vi.fn(async () => {}),
  checkReadiness: vi.fn(async () => []),
  describeChat: vi.fn(async () => ({ chatType: 'supergroup' as const, title: 'Test group' })),
  send: vi.fn(async () => ({ providerMessageId: 'test-indicator' })),
};
let app: ReturnType<typeof createApp>;
let cookie: string;
let webhookApp: ReturnType<typeof createApp>;
let instant = new Date('2026-10-10T04:01:00Z');
const webhookSecret = Buffer.alloc(32, 8).toString('base64url');
const webhookLogs: string[] = [];
const webhookLogger = pino({}, { write: (line: string) => webhookLogs.push(line) });

afterEach(() => {
  instant = new Date('2026-10-10T04:01:00Z');
});

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') }));
  await pool.query('TRUNCATE bot_connections CASCADE');
  const session = await signInSeedAdmin(pool, {
    id: 'channels-admin',
    email: 'channels@pointstar.example',
  });

  cookie = session.cookie;
  const services = {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
    telegram: provider,
    connectionSetup: {
      masterKey: Buffer.alloc(32, 7).toString('base64'),
      publicBaseUrl: 'https://simpul.example',
      now: () => instant,
      newId: randomUUID,
      newWebhookSecret: () => Buffer.alloc(32, 8).toString('base64url'),
      newCode: () => randomUUID().replaceAll('-', ''),
    },
    webhook: {
      resolveConnection: createConnectionResolver(pool),
      lookupConnection: createConnectionLookup(pool),
      secretStore: createSecretStore(Buffer.alloc(32, 7).toString('base64')),
      provider: createTelegramProvider('https://telegram.example', vi.fn<typeof fetch>()),
      now: () => instant,
    },
  };

  app = createApp('api', undefined, undefined, services);
  webhookApp = createApp('webhook', undefined, webhookLogger, services);
}, 120000);

async function connectBot() {
  const connection = await request(app)
    .post('/api/v1/telegram/connections')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'shared-bot')
    .send({ connectionName: 'Shared bot', botToken: token });

  expect(connection.status).toBe(201);

  return connection.body.data.id as string;
}

async function expectConnectionCard(channelIds: string[]) {
  const cards = await request(app).get('/api/v1/telegram/connections').set('Cookie', cookie);

  expect(cards.status).toBe(200);
  expect(cards.body.data).toHaveLength(1);
  expect(
    cards.body.data[0].groups.map((group: { channelId: string }) => group.channelId).sort(),
  ).toEqual(channelIds.sort());
  expect(cards.text).not.toContain(token);
}

test('SRS T-15: one connection serves two channels; the second channel needs no token', async () => {
  const connectionId = await connectBot();
  const beforeSecrets = (await pool.query('SELECT * FROM secrets ORDER BY id')).rows;
  const first = await request(app)
    .post('/api/v1/channels')
    .set('Cookie', cookie)
    .send({ botConnectionId: connectionId, providerChatId: '-12345', displayName: 'First group' });

  expect(first.status).toBe(201);
  const second = await request(app).post('/api/v1/channels').set('Cookie', cookie).send({
    botConnectionId: connectionId,
    providerChatId: '-100987654321',
    displayName: 'Second group',
  });

  expect(second.status).toBe(201);
  expect(second.body.data.id).not.toBe(first.body.data.id);
  expect(
    (await pool.query('SELECT bot_connection_id FROM channels ORDER BY display_name')).rows,
  ).toEqual([{ bot_connection_id: connectionId }, { bot_connection_id: connectionId }]);
  expect((await pool.query('SELECT id FROM bot_connections')).rowCount).toBe(1);
  expect((await pool.query('SELECT * FROM secrets ORDER BY id')).rows).toEqual(beforeSecrets);
  expect(provider.verifyCredential).toHaveBeenCalledExactlyOnceWith(token);
  expect(provider.registerWebhook).toHaveBeenCalledTimes(1);
  await expectConnectionCard([first.body.data.id, second.body.data.id]);
});

test('SRS T-24: a connection code is shown once, stored as a hash and expires after 15 minutes', async () => {
  const sharedConnectionId = await connectBot();
  const issued = await request(app)
    .post(`/api/v1/telegram/connections/${sharedConnectionId}/sessions`)
    .set('Cookie', cookie)
    .send({ purpose: 'identify_group' });

  expect(issued.status).toBe(201);
  expect(issued.body.data.command).toMatch(/^\/simpul_connect [0-9a-f]{32}$/u);
  expect(issued.body.data.expiresAt).toBe('2026-10-10T04:16:00.000Z');
  expect(issued.body.data.state).toBe('pending');
  const poll = await request(app)
    .get(`/api/v1/telegram/connection-sessions/${issued.body.data.id}`)
    .set('Cookie', cookie);

  expect(poll.status).toBe(200);
  expect(poll.body.data).toMatchObject({ state: 'pending', candidate: null });
  expect(poll.text).not.toContain(issued.body.data.command.split(' ')[1]);
  const row = (
    await pool.query('SELECT * FROM channel_connection_sessions WHERE id = $1', [
      issued.body.data.id,
    ])
  ).rows[0];

  expect(row.code_hash).toHaveLength(32);
  expect(JSON.stringify(row)).not.toContain(issued.body.data.command.split(' ')[1]);
});

async function issueCode(connectionId: string) {
  const response = await request(app)
    .post(`/api/v1/telegram/connections/${connectionId}/sessions`)
    .set('Cookie', cookie)
    .send({ purpose: 'identify_group' });

  expect(response.status).toBe(201);

  return response.body.data as { id: string; command: string };
}

function pollCode(sessionId: string) {
  return request(app)
    .get(`/api/v1/telegram/connection-sessions/${sessionId}`)
    .set('Cookie', cookie);
}

function sendCommand(connectionId: string, text: string, chatId = -54321) {
  return request(webhookApp)
    .post(`/api/v1/webhooks/telegram/${connectionId}`)
    .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret)
    .send({
      update_id: 123,
      message: { text, chat: { id: chatId, type: 'supergroup', title: 'Candidate group' } },
    });
}

async function expectNoIngestion() {
  expect((await pool.query('SELECT id FROM messages_raw')).rowCount).toBe(0);
  expect((await pool.query('SELECT id FROM channels WHERE monitored')).rowCount).toBe(0);
}

test('SRS T-24: one use identifies only a candidate; replay cannot change its group', async () => {
  const connectionId = await connectBot();
  const issued = await issueCode(connectionId);
  const count = (await pool.query('SELECT id FROM channels')).rowCount;

  expect((await sendCommand(connectionId, issued.command)).status).toBe(200);
  const candidate = await pollCode(issued.id);

  expect(candidate.body.data).toMatchObject({
    state: 'identified',
    candidate: { providerChatId: '-54321', title: 'Candidate group', chatType: 'supergroup' },
  });
  expect((await sendCommand(connectionId, issued.command, -99999)).status).toBe(200);
  expect((await pollCode(issued.id)).body).toEqual(candidate.body);
  expect((await pool.query('SELECT id FROM channels')).rowCount).toBe(count);
  await expectNoIngestion();
});

test('SRS T-24: an identified code creates one draft and a replay creates nothing', async () => {
  const connectionId = await connectBot();
  const issued = await issueCode(connectionId);

  expect((await sendCommand(connectionId, issued.command, -54322)).status).toBe(200);
  const submit = () =>
    request(app).post('/api/v1/channels').set('Cookie', cookie).send({
      botConnectionId: connectionId,
      sessionId: issued.id,
      displayName: 'Identified group',
    });
  const first = await submit();

  expect(first.status).toBe(201);
  expect(first.body.data).toMatchObject({
    monitored: false,
    providerChatId: '-54322',
    providerChatTitle: 'Candidate group',
    providerChatType: 'supergroup',
  });
  const repeat = await submit();

  expect(repeat.status).toBe(410);
  expect(repeat.body.error.code).toBe('E-TG-SESSION-EXPIRED');
  expect((await pollCode(issued.id)).body.data).toMatchObject({
    state: 'expired',
    candidate: null,
  });
  await expectNoIngestion();
});

test('SRS T-24: at exactly 15 minutes a code expires and connects nothing', async () => {
  const connectionId = await connectBot();
  const issued = await issueCode(connectionId);
  const count = (await pool.query('SELECT id FROM channels')).rowCount;

  instant = new Date('2026-10-10T04:16:00Z');
  expect((await sendCommand(connectionId, issued.command, -54323)).status).toBe(200);
  expect((await pollCode(issued.id)).body.data).toMatchObject({
    state: 'expired',
    candidate: null,
  });
  const submit = await request(app)
    .post('/api/v1/channels')
    .set('Cookie', cookie)
    .send({ botConnectionId: connectionId, sessionId: issued.id, displayName: 'Expired group' });

  expect(submit.status).toBe(410);
  expect(submit.body.error.code).toBe('E-TG-SESSION-EXPIRED');
  expect((await pool.query('SELECT id FROM channels')).rowCount).toBe(count);
  await expectNoIngestion();
});

test('SRS T-24: a wrong code and ordinary text store no message or candidate', async () => {
  const connectionId = await connectBot();
  const issued = await issueCode(connectionId);
  const before = (
    await pool.query('SELECT * FROM channel_connection_sessions WHERE id = $1', [issued.id])
  ).rows;

  expect((await sendCommand(connectionId, `/simpul_connect ${'0'.repeat(32)}`)).status).toBe(200);
  expect((await sendCommand(connectionId, 'private-message-marker')).status).toBe(200);
  expect(
    (await pool.query('SELECT * FROM channel_connection_sessions WHERE id = $1', [issued.id])).rows,
  ).toEqual(before);
  expect((await pollCode(issued.id)).body.data).toMatchObject({
    state: 'pending',
    candidate: null,
  });
  await expectNoIngestion();
});

test('A webhook with a wrong secret returns 403 E-WEBHOOK-FORBIDDEN and logs no payload', async () => {
  const connectionId = await connectBot();
  const response = await request(webhookApp)
    .post(`/api/v1/webhooks/telegram/${connectionId}`)
    .set('X-Telegram-Bot-Api-Secret-Token', 'wrong-secret')
    .set('Content-Type', 'application/json')
    .send('{private-webhook-payload-marker');

  expect(response.status).toBe(403);
  expect(response.body.error.code).toBe('E-WEBHOOK-FORBIDDEN');
  expect(response.body.error).not.toHaveProperty('message');
  expect(webhookLogs.some((line) => JSON.parse(line).status === 403)).toBe(true);
  expect(webhookLogs.join('')).not.toContain('private-webhook-payload-marker');
  expect(webhookLogs.join('')).not.toContain('wrong-secret');
  await expectNoIngestion();
});

test('SRS T-20: POST /channels twice with the same chat id produces one row and one 409 E-TG-CHANNEL-DUPLICATE', async () => {
  const connectionId = await connectBot();
  const submit = () =>
    request(app).post('/api/v1/channels').set('Cookie', cookie).send({
      botConnectionId: connectionId,
      providerChatId: '-54330',
      displayName: 'Duplicate group',
    });
  const responses = await Promise.all([submit(), submit()]);

  expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  expect(responses.find((response) => response.status === 409)?.body.error.code).toBe(
    'E-TG-CHANNEL-DUPLICATE',
  );
  const rows = (await pool.query('SELECT id FROM channels WHERE provider_chat_id = $1', ['-54330']))
    .rows;

  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(responses.find((response) => response.status === 201)?.body.data.id);
  expect(
    (
      await pool.query('SELECT id FROM config_audit WHERE table_name = $1 AND record_id = $2', [
        'channels',
        rows[0].id,
      ])
    ).rowCount,
  ).toBe(1);
  await expectNoIngestion();
});

test.each(['42', '+42'])(
  'SRS T-29: a positive chat id %s returns 422 E-TG-CHAT-TYPE-UNSUPPORTED and stores nothing',
  async (providerChatId) => {
    const connectionId = await connectBot();
    const before = (await pool.query('SELECT * FROM channels ORDER BY id')).rows;
    const response = await request(app)
      .post('/api/v1/channels')
      .set('Cookie', cookie)
      .send({ botConnectionId: connectionId, providerChatId, displayName: 'Private chat' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('E-TG-CHAT-TYPE-UNSUPPORTED');
    expect((await pool.query('SELECT * FROM channels ORDER BY id')).rows).toEqual(before);
    await expectNoIngestion();
  },
);

test('SRS T-17: a saved draft reopens with monitored false, no indicator and no sent message', async () => {
  const connectionId = await connectBot();
  const beforeCalls = [
    provider.verifyCredential.mock.calls.length,
    provider.registerWebhook.mock.calls.length,
  ];
  const saved = await request(app).post('/api/v1/channels').set('Cookie', cookie).send({
    botConnectionId: connectionId,
    providerChatId: '-54340',
    displayName: 'Saved draft',
    class: 'internal',
    primaryLanguage: 'id',
  });

  expect(saved.status).toBe(201);
  expect(saved.body.data).toMatchObject({
    monitored: false,
    connectionStatus: 'draft',
    lastVerification: null,
    monitoringStartedAt: null,
  });
  const stored = await pool.query(
    'SELECT monitored, visible_indicator_message_id, monitoring_started_at FROM channels WHERE id = $1',
    [saved.body.data.id],
  );

  expect(stored.rows[0]).toEqual({
    monitored: false,
    visible_indicator_message_id: null,
    monitoring_started_at: null,
  });
  const reopened = await request(app).get('/api/v1/channels').set('Cookie', cookie);

  expect(reopened.status).toBe(200);
  expect(
    reopened.body.data.find((channel: { id: string }) => channel.id === saved.body.data.id),
  ).toEqual(saved.body.data);
  expect([
    provider.verifyCredential.mock.calls.length,
    provider.registerWebhook.mock.calls.length,
  ]).toEqual(beforeCalls);
  expect(provider.send).not.toHaveBeenCalled();
  await expectNoIngestion();
});

test('Channels API section 2: GET returns the saved channel and its full latest check', async () => {
  const connectionId = await connectBot();
  const saved = await request(app).post('/api/v1/channels').set('Cookie', cookie).send({
    botConnectionId: connectionId,
    providerChatId: '-54600',
    displayName: 'Detail group',
  });

  expect(saved.status).toBe(201);
  const response = await request(app)
    .get('/api/v1/channels/' + saved.body.data.id)
    .set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data).toEqual({ ...saved.body.data, verification: null });
  const missing = await request(app)
    .get('/api/v1/channels/' + randomUUID())
    .set('Cookie', cookie);

  expect(missing.status).toBe(404);
  expect(missing.body.error.code).toBe('E-NOT-FOUND');
});

test('Channels API section 2: full latest verification carries only current readiness', async () => {
  const connectionId = await connectBot();
  const saved = await request(app).post('/api/v1/channels').set('Cookie', cookie).send({
    botConnectionId: connectionId,
    providerChatId: '-54601',
    displayName: 'Verified detail group',
  });
  const checks = ['bot_identity', 'group', 'membership', 'privacy_mode', 'webhook', 'inbound'].map(
    (key) => ({
      key,
      status: 'pass',
      message: 'Provider check passed',
      action: null,
    }),
  );
  let latestId = '';

  for (const checkedAt of ['2026-10-10T03:59:00Z', '2026-10-10T04:00:00Z']) {
    const inserted = await pool.query(
      `INSERT INTO channel_verifications (workspace_id, channel_id, bot_connection_id, config_version, credential_version, checks, status, checked_at, expires_at)
       SELECT channel.workspace_id, channel.id, connection.id, channel.config_version, connection.credential_version, $2, 'pass', $3, $3::timestamptz + interval '10 minutes'
       FROM channels AS channel JOIN bot_connections AS connection ON connection.id = channel.bot_connection_id
       WHERE channel.id = $1 RETURNING id`,
      [saved.body.data.id, JSON.stringify(checks), checkedAt],
    );

    latestId = inserted.rows[0].id;
  }

  const detail = () =>
    request(app)
      .get('/api/v1/channels/' + saved.body.data.id)
      .set('Cookie', cookie);

  expect((await detail()).body.data.verification).toEqual({
    id: latestId,
    checks,
    checkedAt: '2026-10-10T04:00:00.000Z',
    expiresAt: '2026-10-10T04:10:00.000Z',
    activationReady: true,
  });
  await pool.query('UPDATE channels SET config_version = config_version + 1 WHERE id = $1', [
    saved.body.data.id,
  ]);
  expect((await detail()).body.data.verification.activationReady).toBe(false);
  expect((await request(app).get('/api/v1/channels/' + saved.body.data.id)).status).toBe(401);
});
