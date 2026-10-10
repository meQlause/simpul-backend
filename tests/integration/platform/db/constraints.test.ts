import { randomUUID } from 'node:crypto';
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

test('A label with empty evidence_message_ids cannot be inserted', async () => {
  await expect(
    pool.query(
      `INSERT INTO labels (workspace_id, unit_id, type, tense, evidence_message_ids, confidence, vocab_version)
    VALUES ($1, $1, 'progress', 'sudah_terjadi', '{}', 1, 1)`,
      [workspaceId],
    ),
  ).rejects.toMatchObject({ code: '23514', constraint: 'labels_evidence_required' });
});

test('A label with a source message in evidence_message_ids can be inserted', async () => {
  const result = await pool.query(
    `INSERT INTO labels (workspace_id, unit_id, type, tense, evidence_message_ids, confidence, vocab_version)
    VALUES ($1, $1, 'progress', 'sudah_terjadi', ARRAY[$1::uuid], 1, 1) RETURNING evidence_message_ids`,
    [workspaceId],
  );
  expect(result.rows).toEqual([{ evidence_message_ids: [workspaceId] }]);
});

async function storeMonitoredChannel(overrides: Record<string, unknown>) {
  const candidate = {
    connection_status: 'active',
    authorization_ack_at: '2026-10-10T04:01:00Z',
    monitoring_started_at: '2026-10-10T04:01:00Z',
    visible_indicator_message_id: '1',
    provider_chat_type: 'supergroup',
    ...overrides,
  };
  return pool.query(
    `INSERT INTO channels (workspace_id, bot_connection_id, provider, provider_chat_id, display_name, monitored, connection_status, authorization_ack_at, monitoring_started_at, visible_indicator_message_id, provider_chat_type)
    VALUES ($1, $1, 'telegram', $2, 'Test active channel', true, $3, $4, $5, $6, $7) RETURNING monitored`,
    [
      workspaceId,
      randomUUID(),
      candidate.connection_status,
      candidate.authorization_ack_at,
      candidate.monitoring_started_at,
      candidate.visible_indicator_message_id,
      candidate.provider_chat_type,
    ],
  );
}

test.each([
  ['connection_status', 'draft'],
  ['connection_status', 'verified'],
  ['connection_status', 'paused'],
  ['connection_status', 'needs_action'],
  ['authorization_ack_at', null],
  ['monitoring_started_at', null],
  ['visible_indicator_message_id', null],
  ['provider_chat_type', null],
])('A channel cannot be stored with monitored = true when %s is %s', async (field, value) => {
  await expect(storeMonitoredChannel({ [String(field)]: value })).rejects.toMatchObject({
    code: '23514',
    constraint: 'channels_monitored_only_when_active',
  });
});

test.each(['group', 'supergroup'])(
  'An active, acknowledged %s with an indicator and monitoring start can be monitored',
  async (providerChatType) => {
    expect((await storeMonitoredChannel({ provider_chat_type: providerChatType })).rows).toEqual([
      { monitored: true },
    ]);
  },
);
