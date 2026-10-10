import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../../src/app.js';
import { createAuthentication, provisionAdmin } from '../../../../src/features/auth/index.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';

const pool = databaseFixture();
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
};
let app: ReturnType<typeof createApp>;
let cookie: string;

async function signIn() {
  const client = await pool.connect();
  try {
    await provisionAdmin(client, {
      id: 'channels-admin',
      name: 'Siti Aminah',
      email: 'channels@pointstar.example',
      token: 'channels-password-token',
      now: new Date(),
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
    await client.query(
      "UPDATE people SET auth_user_id = 'channels-admin' WHERE name = 'Siti Aminah'",
    );
  } finally {
    client.release();
  }
  const authentication = createAuthentication(pool, {
    baseUrl: 'https://simpul.example',
    secret: 'test-only-auth-secret-with-more-than-32-characters',
  });
  await authentication.api.resetPassword({
    body: { token: 'channels-password-token', newPassword: 'test-password-123' },
  });
  const login = await authentication.api.signInEmail({
    body: { email: 'channels@pointstar.example', password: 'test-password-123' },
    asResponse: true,
  });
  cookie = login.headers.get('set-cookie') ?? '';
  return authentication;
}

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') }));
  await pool.query('TRUNCATE bot_connections CASCADE');
  app = createApp('api', undefined, undefined, {
    authentication: await signIn(),
    resolveConnection: createConnectionResolver(pool),
    telegram: provider,
    connectionSetup: {
      masterKey: Buffer.alloc(32, 7).toString('base64'),
      publicBaseUrl: 'https://simpul.example',
      now: () => new Date('2026-10-10T04:01:00Z'),
      newId: randomUUID,
      newWebhookSecret: () => Buffer.alloc(32, 8).toString('base64url'),
    },
  });
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
