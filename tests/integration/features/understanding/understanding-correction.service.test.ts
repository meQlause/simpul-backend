import { beforeAll, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { seedMessageLog, type MessageLogUnits } from '../../../fixtures/message-log.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { scopedTransaction } from '../../../../src/platform/db/scoped-transaction.js';
import { draftCorrection, correctUnit } from '../../../../src/features/understanding/index.js';

const pool = databaseFixture();
const seed = pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') });
const now = new Date('2026-10-14T03:00:00Z');
let units: MessageLogUnits;
let actorId: string;
const model = { generate: vi.fn(async () => '{"operations":[]}') };
const services = { resolveConnection: createConnectionResolver(pool), model, now: () => now };

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
  units = await seedMessageLog(pool, seed.workspaceId);
  await pool.query('ANALYZE'); // the planner needs real row counts for an 8,400-unit workspace
  actorId = (await pool.query("SELECT md5('point-star-person-1')::uuid AS id")).rows[0].id;
}, 120000);

// T27: a create that carries its summary calls no model, and an operation whose evidence lies
// outside the unit writes no label.
test('T27: draftCorrection makes no model call for create with a summary; an operation citing another message writes no label', async () => {
  const categoryId = (
    await pool.query("SELECT id FROM vocab_domains WHERE workspace_id = $1 AND name = 'Order'", [
      seed.workspaceId,
    ])
  ).rows[0].id;
  const draft = await draftCorrection(
    services,
    { workspaceId: seed.workspaceId, unitId: units.rejected },
    { action: 'create', categoryId, summary: 'New order from Toko Berkah, 12 pcs' },
  );

  expect(model.generate).not.toHaveBeenCalled();
  expect(draft).toMatchObject({ action: 'create', categoryId });

  const target = (
    await pool.query("SELECT id, display_id FROM threads WHERE display_id = 'ORD-0098'")
  ).rows[0];
  const labelsOn = async () =>
    (await pool.query('SELECT count(*)::int AS n FROM labels WHERE thread_id = $1', [target.id]))
      .rows[0].n;
  const before = await labelsOn();

  await scopedTransaction(services.resolveConnection, seed.workspaceId, (tx) =>
    correctUnit(
      tx,
      { workspaceId: seed.workspaceId, unitId: units.held, actorId },
      {
        action: 'attach',
        target: { id: target.id, displayId: target.display_id },
        operations: [
          {
            type: 'progress',
            tense: 'sudah_terjadi',
            evidenceMessageIds: [randomUUID()],
            confidence: 1,
          },
        ],
      },
      { now, previousOutcome: 'held' },
    ),
  );

  expect(await labelsOn()).toBe(before);
});
