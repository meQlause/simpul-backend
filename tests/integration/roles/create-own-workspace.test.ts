import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../helpers/database.js';
import { applyMigrations } from '../../helpers/migrations.js';
import { createAuthentication } from '../../../src/features/auth/index.js';

// The command runs as a child process: ~1.6 s alone, past 5 s once under the parallel run.
vi.setConfig({ testTimeout: 20000 });

const pool = databaseFixture(2);
const execute = promisify(execFile);

beforeAll(() => applyMigrations(pool), 120000);

function provision(email: string, smtp?: string, mode = 'own', sender = true) {
  return execute(
    process.execPath,
    [
      'dist/server.js',
      'create-workspace',
      '--name',
      'Own workspace',
      '--admin-name',
      'Own admin',
      '--admin-email',
      email,
      '--timezone',
      'Asia/Jakarta',
      '--database',
      mode,
    ],
    {
      env: {
        ...process.env,
        PROCESS_ROLE: 'api',
        DATABASE_URL: pool.options.connectionString,
        DATABASE_MIGRATION_URL: pool.options.connectionString,
        DATABASE_QUEUE_URL: pool.options.connectionString,
        PUBLIC_BASE_URL: 'https://simpul.example',
        TELEGRAM_API_BASE: 'https://api.telegram.org',
        AUTH_SECRET: 'test-only-auth-secret-with-more-than-32-characters',
        GOOGLE_CLOUD_PROJECT: 'test-project',
        SECRETS_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
        LOG_LEVEL: 'silent',
        SYSTEM_SMTP_URL: smtp,
        SYSTEM_MAIL_FROM: sender ? 'noreply@simpul.example' : undefined,
      },
    },
  );
}

test('create-workspace --database own writes a sign-in account and pending registry without business rows (FR-DB-01)', async () => {
  const result = await provision('own@example.test', 'smtp://mailer.example');
  const rows = await pool.query(
    `SELECT registry.*, account."providerId" FROM workspace_databases registry
    JOIN "user" admin ON admin.id = registry.admin_auth_user_id
    JOIN account ON account."userId" = admin.id WHERE admin.email = $1`,
    ['own@example.test'],
  );

  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0]).toMatchObject({
    workspace_name: 'Own workspace',
    timezone: 'Asia/Jakarta',
    status: 'pending',
    url_secret_ref: null,
    availability_ack_at: null,
    providerId: 'credential',
  });

  for (const table of [
    'workspaces',
    'people',
    'policies',
    'config_audit',
    'secrets',
    'workspace_keys',
  ]) {
    expect((await pool.query(`SELECT count(*)::int count FROM ${table}`)).rows[0].count).toBe(0);
  }

  const auth = createAuthentication(pool, {
    baseUrl: 'https://simpul.example',
    secret: 'test-only-auth-secret-with-more-than-32-characters',
  });
  const reset = await auth.handler(
    new Request('https://simpul.example/api/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://simpul.example' },
      body: JSON.stringify({
        token: new URL(result.stdout.trim()).searchParams.get('token'),
        newPassword: 'own-workspace-password-123',
      }),
    }),
  );

  expect(reset.status).toBe(200);
});

test('create-workspace --database own refuses missing SYSTEM_SMTP_URL without storing an account (FR-DB-01)', async () => {
  await expect(provision('no-smtp@example.test')).rejects.toThrow('SYSTEM_SMTP_URL');
  expect(
    (await pool.query('SELECT id FROM "user" WHERE email = $1', ['no-smtp@example.test'])).rows,
  ).toEqual([]);
});

test('create-workspace refuses an unknown database mode before storing anything (FR-DB-01)', async () => {
  await expect(
    provision('invalid@example.test', 'smtp://mailer.example', 'invalid'),
  ).rejects.toThrow();
  expect(
    (await pool.query('SELECT id FROM "user" WHERE email = $1', ['invalid@example.test'])).rows,
  ).toEqual([]);
});

test('own database provisioning requires SYSTEM_MAIL_FROM for system outage notices (be-stack)', async () => {
  await expect(
    provision('no-sender@example.test', 'smtp://mailer.example', 'own', false),
  ).rejects.toThrow('SYSTEM_MAIL_FROM');
  expect(
    (await pool.query('SELECT id FROM "user" WHERE email = $1', ['no-sender@example.test'])).rows,
  ).toEqual([]);
});
