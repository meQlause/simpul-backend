import { beforeAll, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../helpers/database.js';
import { applyMigrations } from '../../helpers/migrations.js';
import { seedTenantRows } from '../../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../../src/platform/db/connection-resolver.js';
import { backfillEmbeddings } from '../../../src/roles/backfill-embeddings.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000701';
const vector = Array.from({ length: 768 }, () => 0.5);
const embedding = { embed: vi.fn(async (_input: unknown) => vector) };
const services = {
  pool,
  resolveConnection: createConnectionResolver(pool),
  embedding,
  embeddingModel: 'embedding-model',
};

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);

  for (const [index, triageClass] of [['EVENT'], ['QUERY'], ['NOISE'], [null]].entries()) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO messages_raw (workspace_id, channel_id, provider_msg_id, sender_external_id, body, body_safe, server_ts, received_ts, origin)
       VALUES ($1, $1, $2, 'customer', 'private', 'text', now(), now(), 'user') RETURNING id`,
      [workspaceId, `backfill-${index}`],
    );
    const { rows: unit } = await pool.query<{ id: string }>(
      `INSERT INTO units (workspace_id, channel_id, text, triage_class, ts_first, ts_last)
       VALUES ($1, $1, 'unit', $2, now(), now()) RETURNING id`,
      [workspaceId, triageClass[0]],
    );

    await pool.query(
      'INSERT INTO unit_messages (workspace_id, unit_id, message_id) VALUES ($1, $2, $3)',
      [workspaceId, unit[0].id, rows[0].id],
    );
  }
}, 120000);

// T13 — AC2: the backfill embeds each EVENT or QUERY unit without a row and reports the count; a second run embeds none.
test('RAG (AC2): backfill-embeddings embeds each non-NOISE unit without a row and a second run embeds none', async () => {
  // The fixture already stores one embedding (the seed's own unit), so the rows are counted from here.
  const stored = async () =>
    (await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM unit_embeddings'))
      .rows[0].count;
  const before = await stored();

  expect(await backfillEmbeddings(services)).toBe(2);
  expect(await backfillEmbeddings(services)).toBe(0);
  expect(await stored()).toBe(before + 2);
});
