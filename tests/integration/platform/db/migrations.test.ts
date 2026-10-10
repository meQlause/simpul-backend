import { globSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';

const pool = databaseFixture();
// DDL commits need a fresh schema in this file's disposable container per case.
beforeEach(async () => {
  await pool.query(
    'DROP EXTENSION IF EXISTS vector CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public',
  );
});
const tables = [
  'workspaces',
  'people',
  'person_identities',
  'roles',
  'role_members',
  'policies',
  'thresholds',
  'vocab_domains',
  'aliases',
  'templates',
  'display_id_counters',
  'rules',
  'label_rule_matches',
  'bot_connections',
  'channel_connection_sessions',
  'channel_verifications',
  'provider_updates',
  'channels',
  'messages_raw',
  'units',
  'unit_messages',
  'labels',
  'threads',
  'progress_markers',
  'message_thread_link',
  'notifications',
  'digests',
  'corrections',
  'open_questions',
  'orphans',
  'review_items',
  'decisions',
  'config_audit',
  'idempotency_keys',
  'nodes',
  'edges',
  'unit_embeddings',
  'workspace_keys',
  'secrets',
  'mail_connections',
  'workspace_databases',
  'connection_routes',
].sort();

async function tableNames() {
  const result = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  return result.rows.map(({ tablename }) => tablename);
}

test('Migrations apply to an empty PostgreSQL 15 with pgvector and are reversible in order', async () => {
  const migrations = globSync('drizzle/*.sql').sort();
  expect(migrations.length).toBeGreaterThan(0);
  expect(await tableNames()).toEqual([]);
  expect((await pool.query('SHOW server_version')).rows[0].server_version).toMatch(/^15\./);
  for (const migration of migrations) {
    await pool.query(readFileSync(migration, 'utf8'));
  }
  expect(await tableNames()).toEqual(tables);
  expect(
    (await pool.query("SELECT extname FROM pg_extension WHERE extname = 'vector'")).rowCount,
  ).toBe(1);
  for (const migration of migrations.toReversed()) {
    await pool.query(readFileSync(join('drizzle/down', basename(migration)), 'utf8'));
  }
  expect(await tableNames()).toEqual([]);
  for (const migration of migrations) {
    await pool.query(readFileSync(migration, 'utf8'));
  }
  expect(await tableNames()).toEqual(tables);
}, 30000);

test('System-side workspace keys and secrets exist without a local workspaces row, retaining the secret-to-key foreign key', async () => {
  await applyMigrations(pool);
  const workspaceId = '00000000-0000-4000-8000-000000000001';
  await pool.query('INSERT INTO workspace_keys (workspace_id, wrapped_key) VALUES ($1, $2)', [
    workspaceId,
    Buffer.from('wrapped'),
  ]);
  await pool.query(
    "INSERT INTO secrets (workspace_id, purpose, ciphertext, nonce) VALUES ($1, 'database_url', $2, $3)",
    [workspaceId, Buffer.from('encrypted'), Buffer.alloc(12)],
  );
  expect(
    (await pool.query('SELECT id FROM workspaces WHERE id = $1', [workspaceId])).rowCount,
  ).toBe(0);
  await expect(
    pool.query('DELETE FROM workspace_keys WHERE workspace_id = $1', [workspaceId]),
  ).rejects.toMatchObject({ code: '23503' });
});
