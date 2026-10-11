import { beforeAll, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { archiveClosed } from '../../../../src/features/work/work-lifecycle.service.js';
import { resolveRuntimeUnit } from '../../../../src/features/understanding/understanding-runtime.service.js';

const pool = databaseFixture();
const workspaceId = randomUUID();
const foreignId = randomUUID();
const now = new Date('2026-10-25T04:01:00Z');
const resolveConnection = createConnectionResolver(pool);
const publishComprehend = vi.fn();
let recentId: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
  await seedTenantRows(pool, foreignId);
  await pool.query(
    "UPDATE threads SET status = 'completed', closure_kind = 'completed', closed_at = $1::timestamptz - interval '14 days'",
    [now],
  );
  recentId = randomUUID();
  await pool.query(
    `INSERT INTO threads (id, workspace_id, display_id, status, closure_kind, closed_at, domain_id, channel_id, summary, genesis_confidence)
    VALUES ($1, $2, 'ORD-0002', 'cancelled', 'cancelled', $3::timestamptz - interval '14 days' + interval '1 millisecond', $2, $2, 'Recent closure', 1)`,
    [recentId, workspaceId, now],
  );
}, 30000);

test('Work service surface: closed work archives at exactly 14 days; recent and foreign work remain unchanged', async () => {
  expect(await archiveClosed(resolveConnection, workspaceId, now)).toBe(1);
  expect(
    (await pool.query('SELECT status FROM threads WHERE id = $1', [workspaceId])).rows[0].status,
  ).toBe('archived');
  expect(
    (await pool.query('SELECT status FROM threads WHERE id = $1', [recentId])).rows[0].status,
  ).toBe('cancelled');
  expect(
    (await pool.query('SELECT status FROM threads WHERE id = $1', [foreignId])).rows[0].status,
  ).toBe('completed');
  expect(await archiveClosed(resolveConnection, workspaceId, now)).toBe(0);
});

test('Work service surface: an explicit id in the live resolver reopens archived work and clears closure fields', async () => {
  await pool.query("UPDATE threads SET status = 'archived' WHERE id = $1", [workspaceId]);
  await pool.query(
    "UPDATE units SET explicit_ids = ARRAY['ORD-0001'], triage_class = 'EVENT' WHERE id = $1",
    [workspaceId],
  );
  await pool.query('DELETE FROM corrections WHERE workspace_id = $1', [workspaceId]);
  await pool.query('DELETE FROM notifications WHERE workspace_id = $1', [workspaceId]);
  await pool.query('DELETE FROM label_rule_matches WHERE workspace_id = $1', [workspaceId]);
  await pool.query('DELETE FROM labels WHERE workspace_id = $1', [workspaceId]);
  await resolveRuntimeUnit(
    { resolveConnection, now: () => now, publishComprehend },
    { workspaceId, unitId: workspaceId },
  );
  expect(
    (
      await pool.query(
        'SELECT status, closed_at, closure_kind, closure_reason, closed_by, last_activity_at FROM threads WHERE id = $1',
        [workspaceId],
      )
    ).rows[0],
  ).toEqual({
    status: 'active',
    closed_at: null,
    closure_kind: null,
    closure_reason: null,
    closed_by: null,
    last_activity_at: now,
  });
  expect(publishComprehend).toHaveBeenCalledWith(expect.anything(), {
    workspaceId,
    unitId: workspaceId,
    threadId: workspaceId,
  });
});

test('Work service surface: a reply reopens its linked archived item, while text resemblance alone does not', async () => {
  await pool.query(
    "UPDATE threads SET status = 'archived', closure_kind = 'completed', closed_at = $2 WHERE id = $1",
    [workspaceId, now],
  );
  const messageId = randomUUID();
  const unitId = randomUUID();

  await pool.query(
    `INSERT INTO messages_raw (id, workspace_id, channel_id, provider_msg_id, sender_external_id, reply_to_id, server_ts, received_ts)
    VALUES ($1, $2, $2, 'reply', 'operator', '1', $3, $3)`,
    [messageId, workspaceId, now],
  );
  await pool.query(
    `INSERT INTO units (id, workspace_id, channel_id, text, triage_class, ts_first, ts_last)
    VALUES ($1, $2, $2, 'Order confirmed', 'EVENT', $3, $3)`,
    [unitId, workspaceId, now],
  );
  await pool.query(
    'INSERT INTO unit_messages (workspace_id, unit_id, message_id) VALUES ($1, $2, $3)',
    [workspaceId, unitId, messageId],
  );
  await resolveRuntimeUnit(
    { resolveConnection, now: () => now, publishComprehend },
    { workspaceId, unitId },
  );
  expect(
    (await pool.query('SELECT status FROM threads WHERE id = $1', [workspaceId])).rows[0].status,
  ).toBe('active');
  expect(
    (await pool.query('SELECT status FROM threads WHERE id = $1', [foreignId])).rows[0].status,
  ).toBe('completed');
  await pool.query(
    "UPDATE threads SET status = 'archived', closure_kind = 'completed', closed_at = $2 WHERE id = $1",
    [workspaceId, now],
  );
  await pool.query("UPDATE units SET explicit_ids = '{}' WHERE id = $1", [workspaceId]);
  await resolveRuntimeUnit(
    { resolveConnection, now: () => now, publishComprehend },
    { workspaceId, unitId: workspaceId },
  );
  expect(
    (await pool.query('SELECT status FROM threads WHERE id = $1', [workspaceId])).rows[0].status,
  ).toBe('archived');
});
