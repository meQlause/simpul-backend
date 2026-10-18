import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, expect, test } from 'vitest';
import { databaseFixture } from '../../helpers/database.js';
import { applyMigrations } from '../../helpers/migrations.js';
import { createAuthentication } from '../../../src/features/auth/index.js';
import { createApp } from '../../../src/app.js';
import supertest from 'supertest';
import { createWorkspace } from '../../../src/features/workspace/index.js';
import { createConnectionResolver } from '../../../src/platform/db/connection-resolver.js';

const execute = promisify(execFile);
const pool = databaseFixture(2);
// Provisioning and password setup commit; each file owns a disposable database.

beforeAll(() => applyMigrations(pool), 120000);

async function verifySetPasswordLink(link: string) {
  const auth = createAuthentication(pool, {
    baseUrl: 'https://simpul.example',
    secret: 'test-only-auth-secret-with-more-than-32-characters',
  });
  const body = {
    token: new URL(link).searchParams.get('token'),
    newPassword: 'first-password-123',
  };
  const request = (path: string, payload: object) =>
    new Request(`https://simpul.example/api/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://simpul.example' },
      body: JSON.stringify(payload),
    });
  const app = createApp('api', undefined, undefined, {
    authentication: auth,
    resolveConnection: createConnectionResolver(pool),
  });
  const reset = () =>
    supertest(app)
      .post('/api/auth/reset-password')
      .set('Origin', 'https://simpul.example')
      .send(body);
  const attempts = await Promise.all([reset(), reset()]);

  expect(attempts.map((response) => response.status).sort()).toEqual([200, 400]);
  expect(
    (await auth.handler(request('reset-password', { ...body, newPassword: 'replay-password-123' })))
      .status,
  ).toBe(400);
  const login = await auth.handler(
    request('sign-in/email', { email: 'siti@pointstar.example', password: body.newPassword }),
  );

  expect(login.status).toBe(200);
  expect(login.headers.get('set-cookie')).toContain('HttpOnly');
  expect(login.headers.get('set-cookie')).toContain('Secure');
  expect(
    (
      await auth.handler(
        request('sign-up/email', {
          email: 'outsider@pointstar.example',
          password: body.newPassword,
          name: 'Outsider',
        }),
      )
    ).status,
  ).toBeGreaterThanOrEqual(400);
  expect((await pool.query('SELECT count(*)::int AS count FROM "user"')).rows).toEqual([
    { count: 1 },
  ]);
}

async function verifyInitialConfiguration(link: string) {
  const audit = await pool.query(
    'SELECT actor_id, table_name, record_id, "before", "after" FROM config_audit',
  );

  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0]).toMatchObject({
    table_name: 'workspaces',
    before: null,
    after: { name: 'Point Star', timezone: 'Asia/Jakarta' },
  });
  expect(JSON.stringify(audit.rows)).not.toContain(new URL(link).searchParams.get('token'));
  expect(
    (
      await pool.query(
        'SELECT quiet_start, quiet_end, budget_per_hour, digest_time, hold_seconds FROM policies',
      )
    ).rows,
  ).toEqual([
    {
      quiet_start: '21:00:00',
      quiet_end: '07:00:00',
      budget_per_hour: 6,
      digest_time: '08:30:00',
      hold_seconds: 60,
    },
  ]);
  expect(
    (
      await pool.query(
        "SELECT audience, body, editable FROM templates WHERE key = 'update' ORDER BY audience",
      )
    ).rows,
  ).toEqual([
    {
      audience: 'external',
      body: '{{work_id}} · {{customer}} · Your order update is ready.',
      editable: false,
    },
    { audience: 'internal', body: '{{work_id}} · {{customer}} · {{summary}}', editable: true },
  ]);
}

test('create-workspace creates a workspace, an admin person and a sign-in account, and prints a single-use set-password link', async () => {
  const databaseUrl = pool.options.connectionString;
  const result = await execute(
    process.execPath,
    [
      'dist/server.js',
      'create-workspace',
      '--name',
      'Point Star',
      '--admin-name',
      'Siti Aminah',
      '--admin-email',
      'siti@pointstar.example',
      '--timezone',
      'Asia/Jakarta',
    ],
    {
      env: {
        ...process.env,
        PROCESS_ROLE: 'api',
        DATABASE_URL: databaseUrl,
        DATABASE_MIGRATION_URL: databaseUrl,
        DATABASE_QUEUE_URL: databaseUrl,
        PUBLIC_BASE_URL: 'https://simpul.example',
        TELEGRAM_API_BASE: 'https://api.telegram.org',
        AUTH_SECRET: 'test-only-auth-secret-with-more-than-32-characters',
        GEMINI_API_KEY: 'test-model-key',
        GEMINI_MODEL_TRIAGE: 'test',
        GEMINI_MODEL_STANDARD: 'test',
        GEMINI_MODEL_STRONG: 'test',
        GEMINI_MODEL_EMBEDDING: 'test',
        SECRETS_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
        LOG_LEVEL: 'silent',
      },
    },
  );

  expect(result.stdout.trim()).toMatch(/^https:\/\/simpul\.example\/set-password\?token=[^\s]+$/u);
  const rows = await pool.query(`SELECT workspace.name, person.name AS admin, person.email,
    person.auth_user_id = account."userId" AS linked FROM workspaces AS workspace
    JOIN people AS person ON person.id = workspace.admin_person_id
    JOIN account ON account."userId" = person.auth_user_id`);

  expect(rows.rows).toEqual([
    { name: 'Point Star', admin: 'Siti Aminah', email: 'siti@pointstar.example', linked: true },
  ]);
  await verifySetPasswordLink(result.stdout.trim());
  await verifyInitialConfiguration(result.stdout.trim());
});

test('A rejected workspace insert rolls back its admin account and set-password link', async () => {
  const authUserId = '00000000-0000-4000-8000-000000000003';

  await expect(
    createWorkspace(createConnectionResolver(pool), {
      input: {
        name: 'x'.repeat(81),
        'admin-name': 'Test admin',
        'admin-email': 'rollback@example.test',
        timezone: 'Asia/Jakarta',
      },
      workspaceId: '00000000-0000-4000-8000-000000000001',
      adminId: '00000000-0000-4000-8000-000000000002',
      authUserId,
      token: 'rollback-test-token',
      now: new Date('2026-10-10T04:01:00Z'),
      expiresAt: new Date('2026-10-10T05:01:00Z'),
    }),
  ).rejects.toMatchObject({ code: '23514', constraint: 'workspaces_name_length' });
  expect((await pool.query('SELECT id FROM "user" WHERE id = $1', [authUserId])).rows).toEqual([]);
  expect(
    (await pool.query('SELECT id FROM account WHERE "userId" = $1', [authUserId])).rows,
  ).toEqual([]);
  expect(
    (await pool.query('SELECT id FROM verification WHERE value = $1', [authUserId])).rows,
  ).toEqual([]);
});
