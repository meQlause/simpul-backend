import { beforeAll, expect, test, vi } from 'vitest';
import { databaseFixture, createConnectionResolver } from '../helpers/database-mode.js';
import { applyMigrations } from '../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../fixtures/point-star.js';
import { createSecretStore } from '../../src/platform/secrets/index.js';
import { createProviderRegistry } from '../../src/platform/providers/index.js';
import { createFakeProvider } from '../helpers/providers/fake.js';
import { comprehendUnit } from '../../src/features/understanding/understanding.comprehension.js';
import { sendNotification } from '../../src/features/delivery/delivery-send.service.js';
import { routeLabel } from '../../src/features/delivery/delivery-routing.service.js';

const pool = databaseFixture();
const startedAt = new Date('2026-10-10T04:00:00Z');
const seed = pointStarSeed({ now: () => startedAt });
const secretStore = createSecretStore(Buffer.alloc(32, 4).toString('base64'));
const generate = vi.fn();
const exchange = vi.fn(async () => {});
const providers = createProviderRegistry([
  { ...createFakeProvider(exchange), provider: 'telegram' },
]);
let now = startedAt;
let threadId: string;
const services = {
  resolveConnection: createConnectionResolver(pool),
  now: () => now,
  model: { generate },
  alert: vi.fn(),
  providers,
  secretStore,
  publicBaseUrl: 'https://simpul.example',
};

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
  threadId = (await pool.query("SELECT id FROM threads WHERE display_id = 'ORD-0091'")).rows[0].id;
  await pool.query('UPDATE rules SET active = false WHERE workspace_id = $1', [seed.workspaceId]);
  await pool.query(
    `INSERT INTO rules (workspace_id, name, domain_id, condition_text, event_type, recipient_role_id, template_id)
    SELECT $1, 'Retraction ' || event, md5('point-star-domain-Order')::uuid, 'Confirmed update', event,
      md5('point-star-role-2')::uuid, md5('point-star-template-internal')::uuid FROM unnest(ARRAY['progress','blocker']) event`,
    [seed.workspaceId],
  );
  const tx = await pool.connect();

  try {
    const tokenRef = await secretStore.put(tx, seed.workspaceId, {
      purpose: 'bot_token',
      value: 'test-token',
    });

    await tx.query('UPDATE bot_connections SET token_secret_ref = $2 WHERE workspace_id = $1', [
      seed.workspaceId,
      tokenRef,
    ]);
  } finally {
    tx.release();
  }
}, 120000);

async function understand(type: string, retractsOpId?: string) {
  const unitId = (
    await pool.query(
      `INSERT INTO units (workspace_id, channel_id, text, ts_first, ts_last, created_at)
    SELECT workspace_id, channel_id, text, $2, $2, $2 FROM units WHERE workspace_id = $1 AND id = md5('point-star-unit-1000')::uuid RETURNING id`,
      [seed.workspaceId, now],
    )
  ).rows[0].id as string;
  const messageId = (
    await pool.query(`SELECT message_id FROM unit_messages
    WHERE unit_id = md5('point-star-unit-1000')::uuid LIMIT 1`)
  ).rows[0].message_id as string;

  await pool.query(
    'INSERT INTO unit_messages (workspace_id, unit_id, message_id) VALUES ($1, $2, $3)',
    [seed.workspaceId, unitId, messageId],
  );
  generate.mockResolvedValueOnce(
    JSON.stringify({
      operations: [
        {
          type,
          tense: 'sudah_terjadi',
          confidence: 0.95,
          evidenceMessageIds: [messageId],
          ...(retractsOpId ? { retractsOpId } : {}),
        },
      ],
    }),
  );
  await comprehendUnit(services, { workspaceId: seed.workspaceId, threadId, unitId });

  return (await pool.query('SELECT id, op_id FROM labels WHERE unit_id = $1', [unitId]))
    .rows[0] as { id: string; op_id: string };
}

test('REG-004 / SRS T-06: T+40 retraction restores work, cancels the held update, and sends exactly one replacement at T+100', async () => {
  const before = (
    await pool.query('SELECT last_activity_at FROM threads WHERE id = $1', [threadId])
  ).rows[0].last_activity_at;
  const original = await understand('progress');

  await routeLabel(services, { workspaceId: seed.workspaceId, labelId: original.id });
  expect(
    (await pool.query('SELECT last_activity_at FROM threads WHERE id = $1', [threadId])).rows[0]
      .last_activity_at,
  ).toEqual(startedAt);

  now = new Date(startedAt.getTime() + 40000);
  const replacement = await understand('blocker', original.op_id);

  await assertRetraction(original, replacement, before);
  await routeLabel(services, { workspaceId: seed.workspaceId, labelId: replacement.id });
  const rows = (
    await pool.query('SELECT id, label_id FROM notifications WHERE label_id = ANY($1::uuid[])', [
      [original.id, replacement.id],
    ])
  ).rows;

  await sendAt(rows, 60000);

  expect(exchange).not.toHaveBeenCalled();
  await sendAt(rows, 100000);
  await sendAt(rows, 100000);

  expect(exchange).toHaveBeenCalledTimes(1);
  expect(
    (
      await pool.query(
        'SELECT label_id FROM notifications WHERE label_id = ANY($1::uuid[]) AND sent_at IS NOT NULL',
        [[original.id, replacement.id]],
      )
    ).rows,
  ).toEqual([{ label_id: replacement.id }]);
});

async function assertRetraction(
  original: { id: string; op_id: string },
  replacement: { op_id: string },
  before: Date,
) {
  expect(generate.mock.calls[1]?.[0]).toMatchObject({
    context: {
      operations: expect.arrayContaining([expect.objectContaining({ opId: original.op_id })]),
    },
  });
  expect(
    (await pool.query('SELECT cancelled_at FROM notifications WHERE label_id = $1', [original.id]))
      .rows[0].cancelled_at,
  ).toEqual(now);
  expect(
    new Date(
      (
        await pool.query('SELECT previous_state FROM progress_markers WHERE op_id = $1', [
          replacement.op_id,
        ])
      ).rows[0].previous_state.lastActivityAt,
    ),
  ).toEqual(before);
}

async function sendAt(rows: { id: string }[], elapsed: number) {
  now = new Date(startedAt.getTime() + elapsed);

  for (const row of rows) {
    await sendNotification(services, { workspaceId: seed.workspaceId, notificationId: row.id });
  }
}

test('REG-004: a model cannot retract an operation outside its supplied thread context', async () => {
  const target = (
    await pool.query(
      `INSERT INTO labels (workspace_id, unit_id, thread_id, type, tense, evidence_message_ids, confidence, vocab_version)
    SELECT $1, md5('point-star-unit-1000')::uuid, id, 'progress', 'sudah_terjadi',
      ARRAY[md5('point-star-message-1000')::uuid], 0.95, 1
    FROM threads WHERE workspace_id = $1 AND id <> $2 LIMIT 1 RETURNING op_id`,
      [seed.workspaceId, threadId],
    )
  ).rows[0].op_id as string;
  const before = (await pool.query('SELECT count(*)::int AS total FROM progress_markers')).rows[0]
    .total;

  generate.mockClear();
  expect(await understand('blocker', target)).toBeUndefined();
  expect(generate).toHaveBeenCalledTimes(2);
  expect(services.alert).toHaveBeenCalledTimes(1);
  expect(
    (await pool.query('SELECT retracted_at FROM labels WHERE op_id = $1', [target])).rows[0]
      .retracted_at,
  ).toBeNull();
  expect(
    (await pool.query('SELECT count(*)::int AS total FROM progress_markers')).rows[0].total,
  ).toBe(before);
});
