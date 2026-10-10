import { beforeAll, expect, test, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../../../src/app.js';
import { createAuthentication, provisionAdmin } from '../../../../src/features/auth/index.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { DomainError } from '../../../../src/platform/errors/domain-error.js';

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
  checkReadiness: vi.fn(async () => []),
  describeChat: vi.fn(async () => ({ chatType: 'supergroup' as const, title: 'Test group' })),
  send: vi.fn(async () => ({ providerMessageId: 'test-indicator' })),
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
    connectionSetup: {
      masterKey: Buffer.alloc(32, 7).toString('base64'),
      publicBaseUrl: 'https://simpul.example',
      now: () => new Date('2026-10-10T04:01:00Z'),
      newId: randomUUID,
      newWebhookSecret: () => Buffer.alloc(32, 8).toString('base64url'),
      newCode: () => Buffer.alloc(16, 9).toString('hex'),
    },
  };
  app = createApp('api', undefined, undefined, services);
}, 120000);

async function snapshot() {
  const result = await pool.query(
    `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'workspace_id' ORDER BY table_name`,
  );
  const snapshots = await pool.query<{ table_name: string; snapshot: unknown }>(
    (result.rows as { table_name: string }[])
      .map(
        ({ table_name: table }) =>
          `SELECT '${table}' AS table_name,
       COALESCE(jsonb_agg(jsonb_build_object('snapshot', to_jsonb(record)) ORDER BY to_jsonb(record)::text), '[]'::jsonb) AS snapshot
       FROM "${table}" AS record`,
      )
      .join(' UNION ALL '),
  );
  return Object.fromEntries(snapshots.rows.map((row) => [row.table_name, row.snapshot]));
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

async function claimAsAppRole() {
  await pool.query('CREATE ROLE test_app NOLOGIN NOSUPERUSER NOBYPASSRLS');
  await pool.query('GRANT USAGE ON SCHEMA public TO test_app');
  await pool.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO test_app',
  );
  await pool.query('GRANT EXECUTE ON FUNCTION workspace_for_session(text) TO test_app');
  await pool.query('SET ROLE test_app');
  try {
    return await request(app)
      .post('/api/v1/telegram/connections')
      .set('Cookie', cookie)
      .set('Idempotency-Key', 'duplicate-bot')
      .send({ connectionName: 'My bot', botToken: token });
  } finally {
    await pool.query('RESET ROLE');
  }
}

test('SRS T-21: a second workspace cannot claim the same bot or change its webhook', async () => {
  const foreignWorkspace = '00000000-0000-4000-8000-000000100002';
  await seedTenantRows(pool, foreignWorkspace);
  provider.verifyCredential.mockResolvedValueOnce({
    ...account,
    providerAccountId: foreignWorkspace,
  });
  provider.registerWebhook.mockClear();
  const before = await snapshot();
  const response = await claimAsAppRole();
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('E-TG-BOT-IN-USE');
  expect(response.text).not.toContain(foreignWorkspace);
  expect(provider.registerWebhook).not.toHaveBeenCalled();
  expect(await snapshot()).toEqual(before);
});

async function expectSecretReferences(id: string, state: unknown) {
  const stored = await pool.query(
    'SELECT token_secret_ref, webhook_secret_ref FROM bot_connections WHERE id = $1',
    [id],
  );
  expect(stored.rows[0].token_secret_ref).not.toBe(token);
  expect(
    (
      await pool.query('SELECT id FROM secrets WHERE id = ANY($1::uuid[])', [
        Object.values(stored.rows[0]),
      ])
    ).rowCount,
  ).toBe(2);
  expect(JSON.stringify(state)).not.toContain(token);
  expect(JSON.stringify(state)).not.toContain(Buffer.alloc(32, 8).toString('base64url'));
}

test('SRS T-21: a foreign webhook conflict rolls back the connection and all secret writes', async () => {
  provider.registerWebhook.mockRejectedValueOnce(new DomainError('E-TG-WEBHOOK-CONFLICT'));
  const before = await snapshot();
  const response = await request(app)
    .post('/api/v1/telegram/connections')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'foreign-webhook')
    .send({ connectionName: 'My bot', botToken: token });
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('E-TG-WEBHOOK-CONFLICT');
  expect(await snapshot()).toEqual(before);
});

test('Creating a connection stores encrypted references, audits safe metadata, and replays one webhook setup', async () => {
  provider.registerWebhook.mockClear();
  provider.verifyCredential.mockResolvedValueOnce({ ...account, privacyModeOk: false });
  const create = (connectionName = 'My bot') =>
    request(app)
      .post('/api/v1/telegram/connections')
      .set('Cookie', cookie)
      .set('Idempotency-Key', 'successful-create')
      .send({ connectionName, botToken: token });
  const first = await create();
  expect(first.status).toBe(201);
  expect(first.body.data).toMatchObject({
    provider: 'telegram',
    status: 'needs_action',
    credentialVersion: 1,
    credentialsPresent: true,
    groups: [],
  });
  const beforeReplay = await snapshot();
  const replay = await create();
  expect(replay.status).toBe(201);
  expect(replay.body).toEqual(first.body);
  expect(await snapshot()).toEqual(beforeReplay);
  expect(provider.registerWebhook).toHaveBeenCalledExactlyOnceWith(
    { credential: token },
    `https://simpul.example/api/v1/webhooks/telegram/${first.body.data.id}`,
    Buffer.alloc(32, 8).toString('base64url'),
  );
  await expectSecretReferences(first.body.data.id, beforeReplay);
});

test('A reused connection key with a changed payload returns an idempotency conflict', async () => {
  const before = await snapshot();
  const changed = await request(app)
    .post('/api/v1/telegram/connections')
    .set('Cookie', cookie)
    .set('Idempotency-Key', 'successful-create')
    .send({ connectionName: 'Changed bot name', botToken: token });
  expect(changed.status).toBe(409);
  expect(changed.body.error.code).toBe('E-TG-IDEMPOTENCY-CONFLICT');
  expect(await snapshot()).toEqual(before);
});
