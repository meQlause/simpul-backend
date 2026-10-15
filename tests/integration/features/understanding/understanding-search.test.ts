import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { scopedTransaction } from '../../../../src/platform/db/scoped-transaction.js';
import { embedUnit } from '../../../../src/features/understanding/understanding-embed.service.js';
import { selectCandidates } from '../../../../src/features/work/work-candidates.repository.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000601';
const resolve = createConnectionResolver(pool);
const now = new Date('2026-10-15T09:00:00Z');
const vector = Array.from({ length: 768 }, (_item, index) => (index === 0 ? 1 : 0));
const embedding = { embed: vi.fn(async (_input: unknown) => vector) };
const services = { resolveConnection: resolve, embedding, embeddingModel: 'embedding-model' };
let sequence = 0;

// A unit of the channel with one message, triaged as `triageClass`.
async function unitWith(triageClass: string | null, when = '2026-10-15T08:00:00Z') {
  sequence += 1;
  const { rows: message } = await pool.query<{ id: string }>(
    `INSERT INTO messages_raw (workspace_id, channel_id, provider_msg_id, sender_external_id, body, body_safe, server_ts, received_ts, origin)
     VALUES ($1, $1, $2, 'customer', 'private', $3, $4, $4, 'user') RETURNING id`,
    [workspaceId, `search-${sequence}`, `pesanan ${sequence}`, when],
  );
  const { rows: unit } = await pool.query<{ id: string }>(
    `INSERT INTO units (workspace_id, channel_id, text, triage_class, ts_first, ts_last)
     VALUES ($1, $1, 'unit', $2, $3, $3) RETURNING id`,
    [workspaceId, triageClass, when],
  );

  await pool.query(
    'INSERT INTO unit_messages (workspace_id, unit_id, message_id) VALUES ($1, $2, $3)',
    [workspaceId, unit[0].id, message[0].id],
  );

  return unit[0].id;
}

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
}, 120000);

beforeEach(async () => {
  await pool.query('TRUNCATE unit_embeddings, message_thread_link, threads CASCADE');
  embedding.embed.mockClear();
});

// T4 — AC1: one 768-value vector per EVENT or QUERY unit; a NOISE unit gets none; a second run stores nothing new.
test('RAG (AC1): embedUnit stores one embedding for a non-NOISE unit, none for NOISE, and skips a stored one', async () => {
  const event = await unitWith('EVENT');
  const noise = await unitWith('NOISE');

  await embedUnit(services, { workspaceId, unitId: event });
  await embedUnit(services, { workspaceId, unitId: noise });
  await embedUnit(services, { workspaceId, unitId: event });

  const rows = await pool.query(
    'SELECT unit_id, model, vector_dims(embedding) AS dims FROM unit_embeddings',
  );

  expect(rows.rows).toEqual([{ unit_id: event, model: 'embedding-model', dims: 768 }]);
  expect(embedding.embed).toHaveBeenCalledTimes(1);
});

// T8 — AC9: with stored embeddings, a candidate whose units resemble the unit scores SEMANTIC above 0.
test('RAG (AC9): a candidate whose units are similar to the unit scores SEMANTIC above zero', async () => {
  const prior = await unitWith('EVENT', '2026-10-14T08:00:00Z');
  const current = await unitWith('EVENT');
  const { rows: thread } = await pool.query<{ id: string }>(
    `INSERT INTO threads (workspace_id, display_id, status, domain_id, channel_id, summary, genesis_confidence)
     VALUES ($1, 'RAG-801', 'active', $1, $1, 'summary', '1') RETURNING id`,
    [workspaceId],
  );
  const { rows: linked } = await pool.query<{ message_id: string }>(
    'SELECT message_id FROM unit_messages WHERE unit_id = $1',
    [prior],
  );

  await pool.query(
    `INSERT INTO message_thread_link (workspace_id, thread_id, message_id, role, confidence) VALUES ($1, $2, $3, 'genesis', '1')`,
    [workspaceId, thread[0].id, linked[0].message_id],
  );
  await embedUnit(services, { workspaceId, unitId: prior });
  await embedUnit(services, { workspaceId, unitId: current });

  const candidates = await scopedTransaction(resolve, workspaceId, (tx) =>
    selectCandidates(
      tx,
      workspaceId,
      {
        channelId: workspaceId,
        unitId: current,
        senderId: null,
        explicitIds: [],
        replyIds: [],
        graphThreadIds: [],
      },
      now,
    ),
  );

  expect(candidates.find((candidate) => candidate.id === thread[0].id)?.semantic).toBeGreaterThan(
    0,
  );
});
