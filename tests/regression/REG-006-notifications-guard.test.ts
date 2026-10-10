import { beforeAll, expect, test } from 'vitest';
import { databaseFixture } from '../helpers/database.js';
import { applyMigrations } from '../helpers/migrations.js';
import { seedTenantRows } from '../fixtures/tenant-rows.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000006';

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
});

async function insertNotification() {
  return pool.query(
    `INSERT INTO notifications (workspace_id, label_id, thread_id, recipient_person_id, kind, channel, body_rendered, held_until)
    VALUES ($1, $1, $1, $1, 'reminder', 'telegram', 'Test reminder', '2026-10-10T04:02:00Z') RETURNING id`,
    [workspaceId],
  );
}

test.each([
  ['tentative', 'tentative', false],
  ['historical', 'active', true],
] as const)(
  'REG-006: Inserting a notification for a %s thread is refused by notifications_guard',
  async (_name, status, historical) => {
    await pool.query(
      "UPDATE threads SET status = $2, historical = $3, expires_at = '2026-10-11T04:01:00Z' WHERE id = $1",
      [workspaceId, status, historical],
    );
    await expect(insertNotification()).rejects.toMatchObject({
      code: 'P0001',
      message: `thread ${workspaceId} cannot notify`,
    });
    expect((await pool.query('SELECT id FROM notifications')).rowCount).toBe(1);
  },
);

test('A confirmed nonhistorical active thread can produce a notification', async () => {
  await pool.query(
    "UPDATE threads SET status = 'active', historical = false, expires_at = NULL WHERE id = $1",
    [workspaceId],
  );
  expect((await insertNotification()).rowCount).toBe(1);
});
