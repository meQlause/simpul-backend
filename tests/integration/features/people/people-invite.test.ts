import { beforeAll, expect, test } from 'vitest';
import supertest from 'supertest';
import { createHash } from 'node:crypto';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { createApp } from '../../../../src/app.js';
import { createAuthentication, provisionAdmin } from '../../../../src/features/auth/index.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';

const pool = databaseFixture();
const DAY = 86400000;
const LINK = /^https:\/\/t\.me\/simpul_workspace_bot\?start=([0-9a-f]{32})$/u;
let app: ReturnType<typeof createApp>;
let cookie: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') }));
  const client = await pool.connect();

  try {
    await provisionAdmin(client, {
      id: 'people-invite-admin',
      name: 'Siti Aminah',
      email: 'siti@pointstar.example',
      token: 'people-invite-password-token',
      now: new Date(),
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
  } finally {
    client.release();
  }

  await pool.query(
    "UPDATE people SET auth_user_id = 'people-invite-admin' WHERE name = 'Siti Aminah'",
  );
  const auth = createAuthentication(pool, {
    baseUrl: 'https://simpul.example',
    secret: 'test-only-auth-secret-with-more-than-32-characters',
  });

  await auth.api.resetPassword({
    body: { token: 'people-invite-password-token', newPassword: 'test-password-123' },
  });
  const login = await auth.api.signInEmail({
    body: { email: 'siti@pointstar.example', password: 'test-password-123' },
    asResponse: true,
  });

  cookie = login.headers.get('set-cookie') ?? '';
  app = createApp('api', undefined, undefined, {
    authentication: auth,
    resolveConnection: createConnectionResolver(pool),
  });
}, 120000);

async function personId(name: string) {
  return (await pool.query<{ id: string }>('SELECT id FROM people WHERE name = $1', [name])).rows[0]
    .id;
}

function invite(id: string) {
  return supertest(app).post(`/api/v1/people/${id}/invite`).set('Cookie', cookie).send();
}

async function listed() {
  const response = await supertest(app).get('/api/v1/people').set('Cookie', cookie);

  return response.body as {
    data: { name: string; telegramStatus: string }[];
    meta: { botUsername: string | null };
  };
}

async function statusOf(name: string) {
  return (await listed()).data.find((person) => person.name === name)?.telegramStatus;
}

function sha256(code: string) {
  return createHash('sha256').update(code).digest();
}

async function storedHash(id: string) {
  return (
    await pool.query<{ code_hash: Buffer }>(
      'SELECT code_hash FROM person_invites WHERE person_id = $1',
      [id],
    )
  ).rows.map((row) => row.code_hash);
}

test('AC1: an invite is a t.me link valid for 7 days; only its hash is stored; a new one voids the old', async () => {
  const rina = await personId('Rina Anggraini');
  const first = await invite(rina);

  expect(first.status).toBe(201);
  const code = LINK.exec(first.body.data.link)?.[1] ?? '';

  expect(code).toHaveLength(32);
  expect(Math.abs(Date.parse(first.body.data.expiresAt) - Date.now() - 7 * DAY)).toBeLessThan(
    60000,
  );
  expect(await storedHash(rina)).toEqual([sha256(code)]);

  const second = await invite(rina);
  const next = LINK.exec(second.body.data.link)?.[1] ?? '';

  expect(next).not.toBe(code);
  expect(await storedHash(rina)).toEqual([sha256(next)]);
});

test('AC1: the audit row names the person and never carries the code', async () => {
  const andi = await personId('Andi Pratama');
  const response = await invite(andi);
  const code = LINK.exec(response.body.data.link)?.[1] ?? '';
  const audit = await pool.query<{ row: string }>(
    "SELECT row_to_json(config_audit)::text AS row FROM config_audit WHERE record_id = $1 AND table_name = 'people' ORDER BY created_at DESC LIMIT 1",
    [andi],
  );

  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0].row).not.toContain(code);
});

test('AC2: unknown or deactivated people, and a bot that is not ready, get 404', async () => {
  expect((await invite('00000000-0000-4000-8000-000000999999')).body.error.code).toBe(
    'E-NOT-FOUND',
  );
  const budi = await personId('Budi Santoso');

  await pool.query('UPDATE people SET active = false WHERE id = $1', [budi]);
  expect((await invite(budi)).status).toBe(404);
  await pool.query('UPDATE people SET active = true WHERE id = $1', [budi]);

  await pool.query("UPDATE bot_connections SET status = 'needs_action'");
  expect((await invite(budi)).status).toBe(404);
  expect((await listed()).meta.botUsername).toBeNull();
  await pool.query("UPDATE bot_connections SET status = 'ready'");
  expect((await listed()).meta.botUsername).toBe('simpul_workspace_bot');
});

test('AC3: telegramStatus is connected, waiting or not_connected', async () => {
  const budi = await personId('Budi Santoso');

  expect(await statusOf('Budi Santoso')).toBe('not_connected');
  await invite(budi);
  expect(await statusOf('Budi Santoso')).toBe('waiting');
  await pool.query(
    "UPDATE person_invites SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE person_id = $1",
    [budi],
  );
  expect(await statusOf('Budi Santoso')).toBe('not_connected');
  await invite(budi);
  await pool.query('UPDATE person_invites SET consumed_at = now() WHERE person_id = $1', [budi]);
  expect(await statusOf('Budi Santoso')).toBe('not_connected');
  await pool.query(
    "UPDATE person_identities SET started_at = now() WHERE person_id = $1 AND provider = 'telegram'",
    [budi],
  );
  expect(await statusOf('Budi Santoso')).toBe('connected');
});

test('AC4: deactivating a person deletes their invite', async () => {
  const rina = await personId('Rina Anggraini');

  await invite(rina);
  const gone = await supertest(app)
    .patch(`/api/v1/people/${rina}`)
    .set('Cookie', cookie)
    .send({ active: false });

  expect(gone.status).toBe(200);
  expect(await storedHash(rina)).toEqual([]);
});
