import { beforeAll, expect, test } from 'vitest';
import { databaseFixture } from '../helpers/database.js';
import { applyMigrations } from '../helpers/migrations.js';
import { seedTenantRows } from '../fixtures/tenant-rows.js';
import { createConnectionResolver } from '../../src/platform/db/connection-resolver.js';
import { storeComprehension } from '../../src/features/understanding/understanding.service.js';
import { claimGate } from '../../src/features/delivery/delivery.rules.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000101';
const resolveConnection = createConnectionResolver(pool);
const operation = {
  type: 'progress',
  tense: 'rencana',
  evidenceMessageIds: [workspaceId],
  confidence: 0.99,
};

beforeAll(async () => {
  await applyMigrations(pool);
  await seedTenantRows(pool, workspaceId);
  await pool.query('TRUNCATE labels CASCADE');
  await pool.query("UPDATE units SET text = 'nanti sore dikirim'");
}, 120000);

test('REG-003 / SRS T-05: nanti sore dikirim is stored with tense rencana and passes no claim gate', async () => {
  await storeComprehension(
    resolveConnection,
    { workspaceId, unitId: workspaceId, threadId: workspaceId },
    { operations: [operation] },
  );
  const labels = await pool.query('SELECT tense, evidence_message_ids FROM labels');
  const notifications = await pool.query('SELECT count(*)::int AS count FROM notifications');

  expect(labels.rows).toEqual([{ tense: 'rencana', evidence_message_ids: [workspaceId] }]);
  expect(claimGate(operation, { status: 'active', historical: false })).toBe(false);
  expect(notifications.rows[0].count).toBe(0);
});

test.each(['rencana', 'kondisional'])('SRS §8.1: %s is never a factual claim', (tense) => {
  expect(claimGate({ ...operation, tense }, { status: 'active', historical: false })).toBe(false);
});

test('SRS §8.1: only evidenced, confident, actual claims on active nonhistorical work pass', () => {
  const actual = { ...operation, tense: 'sudah_terjadi', confidence: 0.75 };

  expect(claimGate(actual, { status: 'active', historical: false })).toBe(true);
  expect(claimGate({ ...actual, confidence: 0.749 }, { status: 'active', historical: false })).toBe(
    false,
  );
  expect(
    claimGate({ ...actual, evidenceMessageIds: [] }, { status: 'active', historical: false }),
  ).toBe(false);
  expect(claimGate(actual, { status: 'tentative', historical: false })).toBe(false);
  expect(claimGate(actual, { status: 'active', historical: true })).toBe(false);
});
