import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';

const pool = databaseFixture(2);
const workspaceId = '00000000-0000-4000-8000-000000000007';

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
});

test('Two concurrent inserts of the same (workspace_id, provider, provider_chat_id) produce one row and one unique violation', async () => {
  const chatId = randomUUID();
  const clients = await Promise.all([pool.connect(), pool.connect()]);

  try {
    const processes = await Promise.all(
      clients.map((client) => client.query('SELECT pg_backend_pid() AS pid')),
    );

    expect(new Set(processes.map((result) => result.rows[0].pid)).size).toBe(2);
    const results = await Promise.allSettled(
      clients.map((client) =>
        client.query(
          `INSERT INTO channels (workspace_id, bot_connection_id, provider, provider_chat_id, display_name)
      VALUES ($1, $1, 'telegram', $2, 'Concurrent test') RETURNING id`,
          [workspaceId, chatId],
        ),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failures = results.filter((result) => result.status === 'rejected');

    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatchObject({ code: '23505', constraint: 'channels_chat_uq' });
  } finally {
    clients.forEach((client) => client.release());
  }

  expect(
    (
      await pool.query(
        'SELECT id FROM channels WHERE workspace_id = $1 AND provider = $2 AND provider_chat_id = $3',
        [workspaceId, 'telegram', chatId],
      )
    ).rowCount,
  ).toBe(1);
});
