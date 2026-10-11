import { beforeAll, expect, test } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { traverseGraph } from '../../../../src/features/understanding/understanding-graph.repository.js';
import { selectCandidates } from '../../../../src/features/work/work-candidates.repository.js';
import { rankedCandidates } from '../../../../src/features/understanding/understanding-scoring.rules.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000201';
const rootId = '00000000-0000-4000-8000-000000000202';
const personId = '00000000-0000-4000-8000-000000000203';
const acceptedThreadId = '00000000-0000-4000-8000-000000000204';
const rejectedThreadId = '00000000-0000-4000-8000-000000000205';
const manualThreadId = '00000000-0000-4000-8000-000000000206';

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
}, 120000);

test('SRS §6.5 traverses two hops and excludes only low-confidence inferred edges', async () => {
  await pool.query('DELETE FROM edges WHERE workspace_id = $1', [workspaceId]);
  await pool.query('DELETE FROM nodes WHERE workspace_id = $1', [workspaceId]);
  await pool.query(
    `INSERT INTO nodes (id, workspace_id, type) VALUES
      ($1, $2, 'Message'), ($3, $2, 'Person'), ($4, $2, 'Thread'), ($5, $2, 'Thread'), ($6, $2, 'Thread')`,
    [rootId, workspaceId, personId, acceptedThreadId, rejectedThreadId, manualThreadId],
  );
  await pool.query(
    `INSERT INTO edges (workspace_id, from_id, to_id, type, weight, confidence, created_by) VALUES
      ($1, $2, $3, 'alias', 0.8, 0.70, 'ai_inferred'),
      ($1, $3, $4, 'participates_in', 0.8, 0.70, 'ai_inferred'),
      ($1, $2, $5, 'participates_in', 0.8, 0.69, 'ai_inferred'),
      ($1, $2, $6, 'participates_in', 0.1, 0.01, 'manual')`,
    [workspaceId, rootId, personId, acceptedThreadId, rejectedThreadId, manualThreadId],
  );

  const client = await pool.connect();
  const nodes = await traverseGraph(client, workspaceId, [rootId]);

  client.release();

  expect(nodes.map((node) => node.id)).toContain(acceptedThreadId);
  expect(nodes.map((node) => node.id)).toContain(manualThreadId);
  expect(nodes.map((node) => node.id)).not.toContain(rejectedThreadId);
  expect(nodes.map((node) => node.id)).toContain(personId);
});

test('SRS §11.1 resolves 30 active work items under 300 ms p95 and traverses under 20 ms p95', async () => {
  await seedPerformanceGraph();
  const client = await pool.connect();
  const now = new Date('2026-10-10T04:01:00Z');

  try {
    const graphP95 = await measureP95(() => traverseGraph(client, workspaceId, [rootId]));
    const resolutionP95 = await measureP95(async () => {
      const graph = await traverseGraph(client, workspaceId, [rootId]);
      const candidates = await selectCandidates(
        client,
        workspaceId,
        {
          channelId: workspaceId,
          unitId: workspaceId,
          senderId: null,
          explicitIds: [],
          replyIds: [],
          graphThreadIds: graph.filter((node) => node.type === 'Thread').map((node) => node.id),
        },
        now,
      );

      return rankedCandidates(
        candidates,
        { bodySafe: 'Performance check', channelId: workspaceId, explicitIds: [] },
        { identity: 0.3, temporal: 0.25, social: 0.2, procedural: 0.15, semantic: 0.1 },
        now.getTime(),
      );
    });

    expect(resolutionP95).toBeLessThan(300);
    expect(graphP95).toBeLessThan(20);
  } finally {
    client.release();
  }
});

async function seedPerformanceGraph() {
  await pool.query(
    `INSERT INTO threads (id, workspace_id, display_id, status, domain_id, channel_id, summary, genesis_confidence)
    SELECT md5('b9-graph-perf-' || n)::uuid, $1, 'B9-' || n, 'active', $1, $1, 'Performance candidate', 0.9
    FROM generate_series(1, 30) AS n ON CONFLICT (id) DO NOTHING`,
    [workspaceId],
  );
  await pool.query('DELETE FROM edges WHERE workspace_id = $1', [workspaceId]);
  await pool.query('DELETE FROM nodes WHERE workspace_id = $1', [workspaceId]);
  await pool.query(
    `INSERT INTO nodes (id, workspace_id, type) VALUES ($1::uuid, $2::uuid, 'Message')
    UNION ALL
    SELECT md5('b9-graph-person-' || n)::uuid, $2::uuid, 'Person' FROM generate_series(1, 20) AS n
    UNION ALL
    SELECT md5('b9-graph-perf-' || n)::uuid, $2::uuid, 'Thread' FROM generate_series(1, 19) AS n`,
    [rootId, workspaceId],
  );
  await pool.query(
    `INSERT INTO edges (workspace_id, from_id, to_id, type, weight, confidence, created_by)
    SELECT $1::uuid, $2::uuid, md5('b9-graph-person-' || n)::uuid, 'alias', 0.9, 0.70, 'ai_inferred'
    FROM generate_series(1, 20) AS n
    UNION ALL
    SELECT $1::uuid, md5('b9-graph-person-' || n)::uuid, md5('b9-graph-perf-' || n)::uuid,
      'participates_in', 0.8, 0.70, 'ai_inferred' FROM generate_series(1, 19) AS n`,
    [workspaceId, rootId],
  );
}

async function measureP95(run: () => Promise<unknown>) {
  const samples: number[] = [];

  for (let index = 0; index < 105; index += 1) {
    const start = performance.now();

    await run();

    if (index >= 5) {
      samples.push(performance.now() - start);
    }
  }

  return samples.toSorted((left, right) => left - right)[Math.ceil(samples.length * 0.95) - 1];
}
