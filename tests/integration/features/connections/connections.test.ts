import { beforeAll, expect, test, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../../src/app.js';
import { createAuthentication, provisionAdmin } from '../../../../src/features/auth/index.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';

const pool = databaseFixture();
const token = 'test-only-bot-token';
const account = {
  providerAccountId: 'new-bot',
  botUsername: 'simpul_workspace_bot',
  botName: 'Simpul workspace bot',
  canJoinGroups: true,
  privacyModeOk: true,
};
const provider = {
  verifyCredential: vi.fn(async (_credential: string) => account),
  registerWebhook: vi.fn(),
};
let app: ReturnType<typeof createApp>;
let cookie: string;
beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') }));
  const client = await pool.connect();
  try {
    await provisionAdmin(client, {
      id: 'connections-admin',
      name: 'Siti Aminah',
      email: 'connections@pointstar.example',
      token: 'connections-password-token',
      now: new Date(),
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
    await client.query(
      "UPDATE people SET auth_user_id = 'connections-admin' WHERE name = 'Siti Aminah'",
    );
  } finally {
    client.release();
  }
  const authentication = createAuthentication(pool, {
    baseUrl: 'https://simpul.example',
    secret: 'test-only-auth-secret-with-more-than-32-characters',
  });
  await authentication.api.resetPassword({
    body: { token: 'connections-password-token', newPassword: 'test-password-123' },
  });
  const login = await authentication.api.signInEmail({
    body: { email: 'connections@pointstar.example', password: 'test-password-123' },
    asResponse: true,
  });
  cookie = login.headers.get('set-cookie') ?? '';
  const services = {
    authentication,
    resolveConnection: createConnectionResolver(pool),
    telegram: provider,
  };
  app = createApp('api', undefined, undefined, services);
}, 120000);

async function snapshot() {
  const result = await pool.query(
    `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'workspace_id' ORDER BY table_name`,
  );
  const rows: Record<string, unknown> = {};
  for (const { table_name: table } of result.rows as { table_name: string }[]) {
    rows[table] = (
      await pool.query(
        `SELECT to_jsonb(record) AS snapshot FROM "${table}" AS record ORDER BY to_jsonb(record)::text`,
      )
    ).rows;
  }
  return rows;
}

test('POST /telegram/connections/verify stores nothing and changes no webhook', async () => {
  const before = await snapshot();
  const response = await request(app)
    .post('/api/v1/telegram/connections/verify')
    .set('Cookie', cookie)
    .send({ botToken: ` ${token} ` });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    data: {
      botUsername: account.botUsername,
      botName: account.botName,
      canJoinGroups: true,
      privacyModeOk: true,
      sameBotAsStored: false,
    },
  });
  expect(provider.verifyCredential).toHaveBeenCalledExactlyOnceWith(token);
  expect(provider.registerWebhook).not.toHaveBeenCalled();
  expect(await snapshot()).toEqual(before);
  expect(response.text).not.toContain(token);
});

test('Verification reports null when the workspace has no stored connection', async () => {
  await pool.query('TRUNCATE bot_connections CASCADE');
  const before = await snapshot();
  const response = await request(app)
    .post('/api/v1/telegram/connections/verify')
    .set('Cookie', cookie)
    .send({ botToken: token });
  expect(response.status).toBe(200);
  expect(response.body.data.sameBotAsStored).toBeNull();
  expect(await snapshot()).toEqual(before);
});

test.each([{}, { botToken: ' ' }, { botToken: token, unexpected: true }])(
  'Verification rejects malformed input before calling the provider: %j',
  async (input) => {
    provider.verifyCredential.mockClear();
    const before = await snapshot();
    const response = await request(app)
      .post('/api/v1/telegram/connections/verify')
      .set('Cookie', cookie)
      .send(input);
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('E-TG-INPUT-INVALID');
    expect(provider.verifyCredential).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  },
);
