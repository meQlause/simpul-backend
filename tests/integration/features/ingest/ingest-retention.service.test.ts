import { beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { retainMessages } from '../../../../src/features/ingest/ingest-retention.service.js';

const pool = databaseFixture();
const workspaceId = randomUUID();
const foreignId = randomUUID();
const editId = randomUUID();
const boundaryId = randomUUID();
const now = new Date('2027-01-10T04:01:00Z');
const resolver = createConnectionResolver(pool);

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
  await seedTenantRows(pool, foreignId);
  await pool.query(
    `INSERT INTO messages_raw (id, workspace_id, channel_id, provider_msg_id, sender_external_id, body, body_safe, supersedes, server_ts, received_ts)
    VALUES ($1, $2, $2, 'edit', 'operator', 'Safe edit', 'Safe edit', $2, $3, $3)`,
    [editId, workspaceId, now],
  );
  await pool.query(
    `INSERT INTO messages_raw (id, workspace_id, channel_id, provider_msg_id, sender_external_id, server_ts, received_ts)
    VALUES ($1, $2, $2, 'boundary', 'operator', $3::timestamptz - interval '90 days', $3)`,
    [boundaryId, workspaceId, now],
  );
  await pool.query('UPDATE progress_markers SET message_id = $1 WHERE workspace_id = $1', [
    workspaceId,
  ]);
}, 30000);

test('Data-spec R-11: retention removes raw messages older than 90 days and their links, retaining threads, corrections and newer edits', async () => {
  const threads = (await pool.query('SELECT * FROM threads ORDER BY id')).rows;
  const corrections = (await pool.query('SELECT * FROM corrections ORDER BY id')).rows;

  await expect(
    pool.query('UPDATE messages_raw SET supersedes = NULL WHERE id = $1', [editId]),
  ).rejects.toThrow('append-only');

  expect(await retainMessages(resolver, workspaceId, now)).toBe(1);
  expect(
    (
      await pool.query('SELECT id FROM messages_raw WHERE workspace_id = $1 ORDER BY id', [
        workspaceId,
      ])
    ).rows
      .map((row) => row.id)
      .sort(),
  ).toEqual([editId, boundaryId].sort());
  expect(
    (await pool.query('SELECT supersedes, body FROM messages_raw WHERE id = $1', [editId])).rows[0],
  ).toEqual({ supersedes: null, body: 'Safe edit' });
  expect(
    (await pool.query('SELECT * FROM unit_messages WHERE workspace_id = $1', [workspaceId])).rows,
  ).toEqual([]);
  expect(
    (await pool.query('SELECT * FROM message_thread_link WHERE workspace_id = $1', [workspaceId]))
      .rows,
  ).toEqual([]);
  expect(
    (await pool.query('SELECT * FROM media_outcomes WHERE workspace_id = $1', [workspaceId])).rows,
  ).toEqual([]);
  expect(
    (
      await pool.query('SELECT message_id FROM progress_markers WHERE workspace_id = $1', [
        workspaceId,
      ])
    ).rows,
  ).toEqual([{ message_id: null }]);
  expect((await pool.query('SELECT * FROM threads ORDER BY id')).rows).toEqual(threads);
  expect((await pool.query('SELECT * FROM corrections ORDER BY id')).rows).toEqual(corrections);
  expect(
    (await pool.query('SELECT id FROM messages_raw WHERE workspace_id = $1', [foreignId])).rows,
  ).toHaveLength(1);
  expect(await retainMessages(resolver, workspaceId, now)).toBe(0);
});

test('Data-spec §6: direct raw-message content changes and manual supersedes changes remain blocked', async () => {
  await expect(
    pool.query("UPDATE messages_raw SET body = 'tampered' WHERE id = $1", [editId]),
  ).rejects.toThrow('append-only');
  await expect(
    pool.query('UPDATE messages_raw SET supersedes = $1 WHERE id = $2', [boundaryId, editId]),
  ).rejects.toThrow('append-only');
});
