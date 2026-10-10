import { beforeAll, expect, test } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000005';

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
});

test('An UPDATE on messages_raw is refused by the trigger', async () => {
  await expect(
    pool.query("UPDATE messages_raw SET body = 'Altered' WHERE id = $1", [workspaceId]),
  ).rejects.toMatchObject({ code: 'P0001', message: 'messages_raw is append-only' });
  expect(
    (await pool.query('SELECT body FROM messages_raw WHERE id = $1', [workspaceId])).rows,
  ).toEqual([{ body: '' }]);
});

test('An edit is a new row, never an update; retention can delete the new raw row', async () => {
  const result = await pool.query(
    `INSERT INTO messages_raw (workspace_id, channel_id, provider_msg_id, sender_external_id, server_ts, received_ts, body, supersedes)
    VALUES ($1::uuid, $1::uuid, '2', $1::text, '2026-10-10T04:02:00Z', '2026-10-10T04:02:00Z', 'Edited message', $1::uuid) RETURNING id, supersedes`,
    [workspaceId],
  );
  expect(result.rows[0].supersedes).toBe(workspaceId);
  expect(
    (await pool.query('DELETE FROM messages_raw WHERE id = $1', [result.rows[0].id])).rowCount,
  ).toBe(1);
});
