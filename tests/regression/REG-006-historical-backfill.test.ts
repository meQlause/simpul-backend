import { beforeAll, expect, test } from 'vitest';
import { databaseFixture } from '../helpers/database.js';
import { applyMigrations } from '../helpers/migrations.js';
import { seedTenantRows } from '../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../src/platform/db/connection-resolver.js';
import { storeComprehension } from '../../src/features/understanding/understanding.service.js';
import { claimGate } from '../../src/features/delivery/delivery.rules.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000006';
const resolveConnection = createConnectionResolver(pool);
const now = new Date('2026-10-10T04:01:00Z');

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
  await pool.query('TRUNCATE labels CASCADE');
  await pool.query(
    `INSERT INTO messages_raw (id, workspace_id, channel_id, provider_msg_id, sender_external_id, body, body_safe, server_ts, received_ts)
    SELECT md5('REG-006-message-' || day)::uuid, $1, $1, 'history-' || day, 'customer',
      'Recorded historical progress', 'Recorded historical progress', $2::timestamptz - day * interval '1 day', $2
    FROM generate_series(1, 30) day`,
    [workspaceId, now],
  );
  await pool.query(
    `INSERT INTO units (id, workspace_id, channel_id, text, triage_class, ts_first, ts_last)
    SELECT md5('REG-006-unit-' || day)::uuid, $1, $1, 'Recorded historical progress', 'EVENT',
      $2::timestamptz - day * interval '1 day', $2::timestamptz - day * interval '1 day'
    FROM generate_series(1, 30) day`,
    [workspaceId, now],
  );
  await pool.query(
    `INSERT INTO unit_messages (workspace_id, unit_id, message_id)
    SELECT $1, md5('REG-006-unit-' || day)::uuid, md5('REG-006-message-' || day)::uuid
    FROM generate_series(1, 30) day`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO threads (id, workspace_id, display_id, status, domain_id, channel_id, summary, genesis_confidence, historical, last_activity_at)
    SELECT md5('REG-006-thread-' || day)::uuid, $1, 'HIS-' || lpad(day::text, 4, '0'),
      'active', $1, $1, 'Historical work', 0.95, true, $2::timestamptz - day * interval '1 day'
    FROM generate_series(1, 30) day`,
    [workspaceId, now],
  );
}, 120000);

test('REG-006 / SRS T-12: 30 days of historical threads and labels produce zero notifications', async () => {
  const { rows } = await pool.query<{ unitId: string; threadId: string; messageId: string }>(
    `SELECT md5('REG-006-unit-' || day)::uuid AS "unitId", md5('REG-006-thread-' || day)::uuid AS "threadId",
      md5('REG-006-message-' || day)::uuid AS "messageId" FROM generate_series(1, 30) day`,
  );

  for (const row of rows) {
    await storeComprehension(
      resolveConnection,
      { workspaceId, unitId: row.unitId, threadId: row.threadId },
      {
        operations: [
          {
            type: 'progress',
            tense: 'sudah_terjadi',
            confidence: 0.95,
            evidenceMessageIds: [row.messageId],
          },
        ],
      },
    );
  }

  const labels = await pool.query<{
    id: string;
    threadId: string;
    tense: string;
    evidenceMessageIds: string[];
    confidence: number;
    status: string;
    historical: boolean;
  }>(
    `SELECT l.id, l.thread_id AS "threadId", l.tense, l.evidence_message_ids AS "evidenceMessageIds",
      l.confidence::float AS confidence, t.status, t.historical FROM labels l
    JOIN threads t ON t.id = l.thread_id AND t.workspace_id = l.workspace_id WHERE l.workspace_id = $1`,
    [workspaceId],
  );

  expect(labels.rows).toHaveLength(30);

  for (const label of labels.rows) {
    expect(claimGate(label, label)).toBe(false);
    await expect(
      pool.query(
        `INSERT INTO notifications (workspace_id, label_id, thread_id, recipient_person_id, channel, body_rendered, held_until)
      VALUES ($1, $2, $3, $1, 'telegram', 'Historical progress', $4)`,
        [workspaceId, label.id, label.threadId, now],
      ),
    ).rejects.toMatchObject({ code: 'P0001', message: `thread ${label.threadId} cannot notify` });
  }

  expect((await pool.query('SELECT * FROM notifications')).rowCount).toBe(0);
});
