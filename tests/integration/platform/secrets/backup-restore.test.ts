import { randomBytes } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import { createSecretStore } from '../../../../src/platform/secrets/index.js';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';

const source = databaseFixture();
const restored = databaseFixture();
const seed = pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') });
const masterKey = randomBytes(32).toString('base64');
const secrets = [
  { purpose: 'bot_token', value: 'backup-test-bot-token' },
  { purpose: 'webhook_secret', value: 'backup-test-webhook-secret' },
  { purpose: 'mail_password', value: 'backup-test-mail-password' },
  { purpose: 'database_url', value: 'postgres://backup-test:secret@customer.example/workspace' },
] as const;
const references: string[] = [];

beforeAll(async () => {
  await applyMigrations(source);
  await loadPointStarSeed(source, seed);
  const client = await source.connect();

  try {
    for (const secret of secrets) {
      references.push(await createSecretStore(masterKey).put(client, seed.workspaceId, secret));
    }
  } finally {
    client.release();
  }

  const backup = source.dump();

  expect(backup).not.toContain(masterKey);

  for (const secret of secrets) {
    expect(backup).not.toContain(secret.value);
  }

  restored.restore(backup);
}, 120000);

test('A database backup restored without SECRETS_MASTER_KEY decrypts no secret', async () => {
  expect(() => createSecretStore('')).toThrow('Invalid master key');
  const unavailableKey = createSecretStore(randomBytes(32).toString('base64'));
  const originalKey = createSecretStore(masterKey);
  const client = await restored.connect();

  try {
    expect((await client.query('SELECT count(*)::int AS count FROM secrets')).rows[0].count).toBe(
      4,
    );

    for (const [index, secret] of secrets.entries()) {
      await expect(
        unavailableKey.get(client, seed.workspaceId, secret.purpose, references[index]),
      ).rejects.toThrow();
      await expect(
        originalKey.get(client, seed.workspaceId, secret.purpose, references[index]),
      ).resolves.toBe(secret.value);
    }
  } finally {
    client.release();
  }
});
