import { beforeAll, expect, test } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { seedTenantRows } from '../../../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { createFromGenesis } from '../../../../src/features/work/index.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000101';
const foreignId = '00000000-0000-4000-8000-000000000102';
const resolveConnection = createConnectionResolver(pool);
const now = new Date('2026-10-10T04:01:00Z');
const genesis = {
  domainId: workspaceId,
  channelId: workspaceId,
  summary: 'Confirmed order',
  confidence: 0.8,
};

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
  await seedTenantRows(pool, foreignId);
  await pool.query('UPDATE display_id_counters SET last_value = 1');
});

test('Two work items created concurrently in one category receive consecutive, distinct display ids', async () => {
  const items = await Promise.all([
    createFromGenesis(resolveConnection, workspaceId, genesis, now),
    createFromGenesis(resolveConnection, workspaceId, genesis, now),
  ]);

  expect(items.map((item) => item?.displayId).sort()).toEqual(['ORD-0002', 'ORD-0003']);
  expect(new Set(items.map((item) => item?.id)).size).toBe(2);
  const { rows } = await pool.query(
    'SELECT last_value FROM display_id_counters WHERE domain_id = $1',
    [workspaceId],
  );

  expect(rows[0].last_value).toBe(3);
});

test('Genesis confidence below 0.55 creates no thread and consumes no display id', async () => {
  const before = await pool.query(
    'SELECT last_value FROM display_id_counters WHERE domain_id = $1',
    [workspaceId],
  );

  expect(
    await createFromGenesis(resolveConnection, workspaceId, { ...genesis, confidence: 0.549 }, now),
  ).toBeNull();
  const after = await pool.query(
    'SELECT last_value FROM display_id_counters WHERE domain_id = $1',
    [workspaceId],
  );

  expect(after.rows).toEqual(before.rows);
});

test('Genesis at 0.55 is tentative for 24 hours; at 0.80 it is active', async () => {
  const item = await createFromGenesis(
    resolveConnection,
    workspaceId,
    { ...genesis, confidence: 0.55 },
    now,
  );

  expect(item?.status).toBe('tentative');
  const { rows } = await pool.query('SELECT expires_at FROM threads WHERE id = $1', [item?.id]);

  expect(rows[0].expires_at.toISOString()).toBe('2026-10-11T04:01:00.000Z');
  const active = await createFromGenesis(resolveConnection, workspaceId, genesis, now);

  expect(active?.status).toBe('active');
});

test('A foreign channel or category cannot consume a workspace display id', async () => {
  const before = await pool.query(
    'SELECT domain_id, last_value FROM display_id_counters ORDER BY domain_id',
  );

  await expect(
    createFromGenesis(resolveConnection, workspaceId, { ...genesis, channelId: foreignId }, now),
  ).rejects.toMatchObject({ code: 'E-NOT-FOUND' });
  await expect(
    createFromGenesis(resolveConnection, workspaceId, { ...genesis, domainId: foreignId }, now),
  ).rejects.toMatchObject({ code: 'E-NOT-FOUND' });
  const after = await pool.query(
    'SELECT domain_id, last_value FROM display_id_counters ORDER BY domain_id',
  );

  expect(after.rows).toEqual(before.rows);
});

test('No work item can be created in a category without a prefix', async () => {
  await pool.query('UPDATE vocab_domains SET id_prefix = NULL WHERE id = $1', [foreignId]);
  await expect(
    createFromGenesis(
      resolveConnection,
      foreignId,
      { ...genesis, domainId: foreignId, channelId: foreignId },
      now,
    ),
  ).rejects.toMatchObject({ code: 'E-VALIDATION' });
  const { rows } = await pool.query(
    'SELECT last_value FROM display_id_counters WHERE domain_id = $1',
    [foreignId],
  );

  expect(rows[0].last_value).toBe(1);
});
