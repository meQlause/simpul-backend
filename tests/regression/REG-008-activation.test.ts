import { randomUUID, randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createConnectionResolver } from '../../src/platform/db/connection-resolver.js';
import { databaseFixture } from '../helpers/database.js';
import { applyMigrations } from '../helpers/migrations.js';
import { signInSeedAdmin } from '../helpers/admin-session.js';
import { loadPointStarSeed, pointStarSeed } from '../fixtures/point-star.js';

const pool = databaseFixture(2);
const now = new Date('2026-10-10T04:01:00Z');
const keys = ['bot_identity', 'group', 'membership', 'privacy_mode', 'webhook', 'inbound'];
const checks = keys.map((key) => ({
  key,
  status: 'pass' as const,
  message: 'Test check',
  action: null,
}));
const provider = {
  verifyCredential: async () => ({
    providerAccountId: 'activation-test-bot',
    botUsername: 'test_bot',
    botName: 'Test bot',
    canJoinGroups: true,
    privacyModeOk: true,
  }),
  registerWebhook: async () => {},
  checkReadiness: vi.fn(async () => checks),
  describeChat: async () => ({ chatType: 'supergroup' as const, title: 'Test group' }),
  send: vi.fn(async () => ({ providerMessageId: 'test-indicator' })),
};
let app: ReturnType<typeof createApp>;
let cookie: string;
let connectionId: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => now }));
  await pool.query('TRUNCATE bot_connections CASCADE');
  const session = await signInSeedAdmin(pool, {
    id: 'activation-admin',
    email: 'activation@pointstar.example',
  });
  cookie = session.cookie;
  const services = {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
    telegram: provider,
    connectionSetup: {
      masterKey: Buffer.alloc(32, 7).toString('base64'),
      publicBaseUrl: 'https://simpul.example',
      now: () => now,
      newId: randomUUID,
      newWebhookSecret: () => randomBytes(32).toString('base64url'),
      newCode: () => randomBytes(16).toString('hex'),
    },
  };
  app = createApp('api', undefined, undefined, services);
  const connection = await request(app)
    .post('/api/v1/telegram/connections')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'activation-bot')
    .send({ connectionName: 'Activation bot', botToken: 'test-only-activation-token' });
  expect(connection.status).toBe(201);
  connectionId = connection.body.data.id;
}, 120000);

beforeEach(() => {
  provider.send.mockRejectedValue(new Error('Indicator failed'));
});

async function draftWithVerification(scenario: string) {
  const id = randomUUID();
  const numericId = BigInt('0x' + id.replaceAll('-', '').slice(0, 10));
  const draft = await request(app)
    .post('/api/v1/channels')
    .set('Cookie', cookie)
    .send({
      botConnectionId: connectionId,
      providerChatId: `-${numericId}`,
      displayName: scenario,
    });
  expect(draft.status).toBe(201);
  const expired = scenario === 'verification-expired';
  const ready = scenario !== 'readiness-incomplete';
  await pool.query(
    `INSERT INTO channel_verifications (id, workspace_id, channel_id, bot_connection_id, config_version, credential_version, checks, status, checked_at, expires_at)
     SELECT $1, workspace_id, id, bot_connection_id, 1, 1, $3, $4, $5, $6 FROM channels WHERE id = $2`,
    [
      id,
      draft.body.data.id,
      JSON.stringify(
        ready
          ? checks
          : checks.map((check) => ({
              ...check,
              status: check.key === 'inbound' ? 'pending' : 'pass',
            })),
      ),
      ready ? 'pass' : 'fail',
      expired ? '2026-10-10T03:51:00Z' : '2026-10-10T04:00:00Z',
      expired ? '2026-10-10T04:01:00Z' : '2026-10-10T04:10:00Z',
    ],
  );
  return { channelId: draft.body.data.id as string, verificationId: id };
}

test.each([
  ['readiness-incomplete', 'E-TG-READINESS-INCOMPLETE', 422],
  ['verification-expired', 'E-TG-VERIFICATION-EXPIRED', 409],
  ['version-conflict', 'E-TG-VERSION-CONFLICT', 409],
  ['indicator-failed', 'E-TG-ACTIVATION-FAILED', 502],
])('REG-008: %s returns %s and stores no active state', async (scenario, code, status) => {
  const draft = await draftWithVerification(String(scenario));
  const response = await request(app)
    .post(`/api/v1/channels/${draft.channelId}/activate`)
    .set('Cookie', cookie)
    .set('Idempotency-Key', String(scenario))
    .send({
      verificationId: draft.verificationId,
      authorizationAck: true,
      expectedConfigVersion: scenario === 'version-conflict' ? 2 : 1,
    });
  expect(response.status).toBe(status);
  expect(response.body.error.code).toBe(code);
  const stored = await pool.query(
    'SELECT monitored, monitoring_started_at, visible_indicator_message_id FROM channels WHERE id = $1',
    [draft.channelId],
  );
  expect(stored.rows[0]).toEqual({
    monitored: false,
    monitoring_started_at: null,
    visible_indicator_message_id: null,
  });
  expect(provider.send).toHaveBeenCalledTimes(scenario === 'indicator-failed' ? 1 : 0);
});
