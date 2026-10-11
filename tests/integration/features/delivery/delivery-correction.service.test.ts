import { beforeAll, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { scopedTransaction } from '../../../../src/platform/db/scoped-transaction.js';
import { createSecretStore } from '../../../../src/platform/secrets/index.js';
import { createProviderRegistry } from '../../../../src/platform/providers/index.js';
import { createFakeProvider } from '../../../helpers/providers/fake.js';
import { recordProgress, rollback } from '../../../../src/features/work/index.js';
import { routeLabel } from '../../../../src/features/delivery/delivery-routing.service.js';
import { sendNotification } from '../../../../src/features/delivery/delivery-send.service.js';
import { correctNotification } from '../../../../src/features/delivery/delivery-correction.service.js';

const pool = databaseFixture();
const instant = new Date('2026-10-10T04:00:00Z');
const seed = pointStarSeed({ now: () => instant });
const exchange = vi.fn(async (_payload: unknown) => {});
const secretStore = createSecretStore(Buffer.alloc(32, 6).toString('base64'));
const services = {
  resolveConnection: createConnectionResolver(pool),
  now: () => new Date(instant.getTime() + 60000),
  providers: createProviderRegistry([{ ...createFakeProvider(exchange), provider: 'telegram' }]),
  secretStore,
  publicBaseUrl: 'https://simpul.example',
};

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
  await scopedTransaction(services.resolveConnection, seed.workspaceId, async (tx) => {
    const token = await secretStore.put(tx, seed.workspaceId, {
      purpose: 'bot_token',
      value: 'test-token',
    });

    await tx.query('UPDATE bot_connections SET token_secret_ref = $2 WHERE workspace_id = $1', [
      seed.workspaceId,
      token,
    ]);
  });
}, 120000);

async function operation(threadId: string) {
  const label = (
    await pool.query(
      `INSERT INTO labels (workspace_id, unit_id, thread_id, domain_id, type, tense, evidence_message_ids, confidence, vocab_version, created_at)
    SELECT workspace_id, unit_id, $3, domain_id, type, tense, evidence_message_ids, confidence, vocab_version, $2
    FROM labels WHERE workspace_id = $1 AND id = md5('point-star-label-1')::uuid RETURNING id, op_id, evidence_message_ids`,
      [seed.workspaceId, instant, threadId],
    )
  ).rows[0];

  await scopedTransaction(services.resolveConnection, seed.workspaceId, async (tx) => {
    await recordProgress(
      tx,
      { workspaceId: seed.workspaceId, threadId },
      {
        opId: label.op_id,
        type: 'progress',
        messageId: label.evidence_message_ids[0],
        now: instant,
      },
    );
  });

  return label;
}

test('SRS §8.6: Not this work restores only its operation, corrects the same recipient and records negative calibration', async () => {
  const threads = (
    await pool.query(
      "SELECT id, last_activity_at FROM threads WHERE status = 'active' AND NOT historical ORDER BY display_id LIMIT 2",
    )
  ).rows;
  const original = await operation(threads[0].id);
  const sibling = await operation(threads[1].id);

  await routeLabel(
    { ...services, now: () => instant },
    { workspaceId: seed.workspaceId, labelId: original.id },
  );
  const notification = (
    await pool.query(
      'SELECT id, recipient_person_id FROM notifications WHERE label_id = $1 LIMIT 1',
      [original.id],
    )
  ).rows[0];

  await sendNotification(services, {
    workspaceId: seed.workspaceId,
    notificationId: notification.id,
  });
  const originalRoom = (exchange.mock.calls[0][0] as { room: string }).room;

  exchange.mockClear();
  await pool.query("UPDATE people SET availability = 'leave' WHERE id = $1", [
    notification.recipient_person_id,
  ]);
  const input = {
    workspaceId: seed.workspaceId,
    notificationId: notification.id,
    opId: original.op_id,
    actorId: notification.recipient_person_id,
  };

  const otherPerson = (
    await pool.query(
      'SELECT id FROM people WHERE workspace_id = $1 AND id <> $2 AND active LIMIT 1',
      [seed.workspaceId, input.actorId],
    )
  ).rows[0].id as string;

  await expect(
    correctNotification(services, { ...input, actorId: otherPerson }),
  ).rejects.toMatchObject({ code: 'E-FORBIDDEN' });
  await correctNotification(services, input);
  await correctNotification(services, input);
  await assertCorrection({ threads, original, sibling, originalRoom });
});

async function assertCorrection(input: {
  threads: { id: string; last_activity_at: Date }[];
  original: { id: string; op_id: string };
  sibling: { id: string };
  originalRoom: string;
}) {
  const { threads, original, sibling, originalRoom } = input;

  expect(
    (await pool.query('SELECT last_activity_at FROM threads WHERE id = $1', [threads[0].id]))
      .rows[0].last_activity_at,
  ).toEqual(threads[0].last_activity_at);
  expect(
    (await pool.query('SELECT last_activity_at FROM threads WHERE id = $1', [threads[1].id]))
      .rows[0].last_activity_at,
  ).toEqual(instant);
  expect(
    (await pool.query('SELECT retracted_at FROM labels WHERE id = $1', [sibling.id])).rows[0]
      .retracted_at,
  ).toBeNull();
  expect(
    (await pool.query('SELECT thread_id FROM labels WHERE id = $1', [original.id])).rows[0]
      .thread_id,
  ).toBeNull();
  expect(
    (
      await pool.query('SELECT op_id, correction_type FROM corrections WHERE op_id = $1', [
        original.op_id,
      ])
    ).rows,
  ).toEqual([{ op_id: original.op_id, correction_type: 'not_this_work' }]);
  expect(exchange).toHaveBeenCalledTimes(1);
  expect(exchange).toHaveBeenCalledWith(expect.objectContaining({ room: originalRoom }));
}

test('SRS §8.6: undoing either of two same-time operations preserves the other operation and its original baseline', async () => {
  const thread = (
    await pool.query(
      "SELECT id, last_activity_at FROM threads WHERE status = 'active' AND NOT historical ORDER BY display_id DESC LIMIT 1",
    )
  ).rows[0];
  const first = await operation(thread.id);
  const second = await operation(thread.id);

  await scopedTransaction(services.resolveConnection, seed.workspaceId, async (tx) => {
    const scope = { workspaceId: seed.workspaceId, threadId: thread.id };

    await rollback(tx, scope, { opId: first.op_id, now: services.now() });
    expect(
      (await tx.query('SELECT last_activity_at FROM threads WHERE id = $1', [thread.id])).rows[0]
        .last_activity_at,
    ).toEqual(instant);
    await rollback(tx, scope, { opId: second.op_id, now: services.now() });
  });
  expect(
    (await pool.query('SELECT last_activity_at FROM threads WHERE id = $1', [thread.id])).rows[0]
      .last_activity_at,
  ).toEqual(thread.last_activity_at);
});
