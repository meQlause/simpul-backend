import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import pino from 'pino';
import request from 'supertest';
import { beforeAll, expect, test, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createConnectionResolver } from '../../src/platform/db/connection-resolver.js';
import { databaseFixture } from '../helpers/database.js';
import { applyMigrations } from '../helpers/migrations.js';
import { signInSeedAdmin } from '../helpers/admin-session.js';
import { loadPointStarSeed, pointStarSeed } from '../fixtures/point-star.js';

const pool = databaseFixture(2);
const token = 'REG-009-original-private-token';
const replacement = 'REG-009-replacement-private-token';
const webhookSecret = 'REG-009-private-webhook-secret-with-32-bytes';
const account = {
  providerAccountId: 'REG-009-bot',
  botUsername: 'regression_bot',
  botName: 'Regression bot',
  canJoinGroups: true,
  privacyModeOk: true,
};
const provider = {
  verifyCredential: vi.fn(async (_credential: string) => account),
  registerWebhook: vi.fn(async () => {}),
  checkReadiness: async () => [],
  describeChat: async () => ({ chatType: 'supergroup' as const, title: 'Test group' }),
  send: async () => ({ providerMessageId: 'test-indicator' }),
};
const lines: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    lines.push(chunk.toString());
    callback();
  },
});
let app: ReturnType<typeof createApp>;
let cookie: string;
let connectionId: string;

beforeAll(async () => {
  await applyMigrations(pool);
  const now = new Date('2026-10-10T04:01:00Z');
  await loadPointStarSeed(pool, pointStarSeed({ now: () => now }));
  await pool.query('TRUNCATE bot_connections CASCADE');
  const session = await signInSeedAdmin(pool, {
    id: 'reg-009-admin',
    email: 'reg-009@pointstar.example',
  });
  cookie = session.cookie;
  app = createApp('api', undefined, pino({ level: 'info' }, sink), {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
    telegram: provider,
    connectionSetup: {
      masterKey: Buffer.alloc(32, 7).toString('base64'),
      publicBaseUrl: 'https://simpul.example',
      now: () => now,
      newId: randomUUID,
      newWebhookSecret: () => webhookSecret,
      newCode: () => 'test-only-code',
    },
  });
}, 120000);

async function assertPrivate(response: { text: string }) {
  const audit = (await pool.query('SELECT * FROM config_audit')).rows;
  expect(lines.length).toBeGreaterThan(0);
  for (const output of [response.text, lines.join(''), JSON.stringify(audit)]) {
    for (const secret of [token, replacement, webhookSecret]) {
      expect(output).not.toContain(secret);
    }
  }
}

test('REG-009 / SRS T-28: after verify, responses, logs and config_audit contain no token or webhook secret', async () => {
  const verify = await request(app)
    .post('/api/v1/telegram/connections/verify')
    .set('Cookie', cookie)
    .send({ botToken: token });
  expect(verify.status).toBe(200);
  await assertPrivate(verify);
});

test('REG-009 / SRS T-28: after create, responses, logs and config_audit contain no token or webhook secret', async () => {
  const created = await request(app)
    .post('/api/v1/telegram/connections')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'REG-009-create')
    .send({ botToken: token, connectionName: 'Regression bot' });
  expect(created.status).toBe(201);
  connectionId = created.body.data.id;
  await assertPrivate(created);
});

test('REG-009 / SRS T-28: after rotate, responses, logs and config_audit contain no token or webhook secret', async () => {
  const rotated = await request(app)
    .put(`/api/v1/telegram/connections/${connectionId}/credentials`)
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'REG-009-rotate')
    .send({ botToken: replacement, expectedCredentialVersion: 1 });
  expect(rotated.status).toBe(200);
  await assertPrivate(rotated);
});

test('REG-009 / SRS T-28: after a failed rotate, responses, logs and config_audit contain no token, secret or credential-bearing Telegram URL', async () => {
  const failure = new Error(`https://telegram.example/bot${replacement}/getMe ${webhookSecret}`);
  failure.name = `ProviderFailure:${replacement}`;
  provider.verifyCredential.mockRejectedValueOnce(failure);
  const rejected = await request(app)
    .put(`/api/v1/telegram/connections/${connectionId}/credentials`)
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'REG-009-failed-rotate')
    .send({ botToken: replacement, expectedCredentialVersion: 2 });
  expect(rejected.status).toBe(500);
  expect(rejected.body.error.code).toBe('E-INTERNAL');
  await assertPrivate(rejected);
  expect((await pool.query('SELECT credential_version FROM bot_connections')).rows).toEqual([
    { credential_version: 2 },
  ]);
  expect((await pool.query('SELECT * FROM config_audit')).rows.length).toBeGreaterThan(0);
  expect(
    lines.map((line) => JSON.parse(line)).filter((line) => line.status !== undefined),
  ).toHaveLength(4);
});
