import { spawnSync } from 'node:child_process';
import { beforeAll, expect, test } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';

const pool = databaseFixture();

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') }));
  // A future provider's schema migration exists, but its adapter registration was omitted.
  await pool.query('ALTER TABLE bot_connections DROP CONSTRAINT bot_provider_valid');
  await pool.query("UPDATE bot_connections SET provider = 'forgotten-provider'");
  await pool.query('CREATE ROLE boot_app LOGIN NOSUPERUSER NOBYPASSRLS');
  await pool.query('GRANT USAGE ON SCHEMA public TO boot_app');
  await pool.query('GRANT SELECT ON bot_connections TO boot_app');
  await pool.query('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO boot_app');
}, 120000);

function environment() {
  const databaseUrl = new URL(String(pool.options.connectionString));

  databaseUrl.username = 'boot_app';

  return {
    ...process.env,
    PROCESS_ROLE: 'worker',
    DATABASE_URL: databaseUrl.toString(),
    DATABASE_MIGRATION_URL: pool.options.connectionString,
    DATABASE_QUEUE_URL: pool.options.connectionString,
    PUBLIC_BASE_URL: 'https://simpul.example',
    TELEGRAM_API_BASE: 'https://telegram.example',
    AUTH_SECRET: 'test-only-auth-secret-with-more-than-32-characters',
    SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    GEMINI_API_KEY: 'test-only-key',
    GEMINI_MODEL_TRIAGE: 'test-model',
    GEMINI_MODEL_STANDARD: 'test-model',
    GEMINI_MODEL_STRONG: 'test-model',
    GEMINI_MODEL_EMBEDDING: 'test-model',
    LOG_LEVEL: 'silent',
  };
}

test.each(['api', 'webhook', 'worker', 'scheduler'])(
  'NFR-AD-02: booting %s with a stored connection whose provider has no registered adapter stops the process with a named error',
  (role) => {
    const result = spawnSync(process.execPath, ['dist/server.js'], {
      env: { ...environment(), PROCESS_ROLE: role },
      encoding: 'utf8',
      timeout: 2000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('UnregisteredProviderError');
    expect(result.stderr).toContain('forgotten-provider');
    expect(result.stderr).not.toContain('test-only-key');
    expect(result.stderr).not.toContain(pool.options.connectionString);
  },
);

test('NFR-AD-02: the bootstrap inventory returns provider names to the application role without exposing tenant rows', async () => {
  await pool.query('SET ROLE boot_app');

  try {
    expect((await pool.query('SELECT * FROM bot_connections')).rows).toEqual([]);
    expect((await pool.query('SELECT * FROM providers_in_use()')).rows).toEqual([
      { provider: 'forgotten-provider' },
    ]);
  } finally {
    await pool.query('RESET ROLE');
  }
});

test('Architecture §9.4: adapter limits come from validated configuration', () => {
  const result = spawnSync(process.execPath, ['dist/server.js'], {
    env: { ...environment(), TELEGRAM_CALL_TIMEOUT_MS: '0' },
    encoding: 'utf8',
    timeout: 2000,
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ConfigurationError');
  expect(result.stderr).toContain('TELEGRAM_CALL_TIMEOUT_MS');
});
