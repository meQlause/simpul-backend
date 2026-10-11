import { beforeAll, expect, test } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { scopedTransaction } from '../../../../src/platform/db/scoped-transaction.js';
import { recordProgress, rollback } from '../../../../src/features/work/index.js';
import { recordStatus } from '../../../../src/features/delivery/delivery-status.service.js';

const pool = databaseFixture();
const instant = new Date('2026-10-10T04:00:00Z');
const seed = pointStarSeed({ now: () => instant });
const services = {
  resolveConnection: createConnectionResolver(pool),
  now: () => new Date(instant.getTime() + 60000),
};

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
}, 120000);

async function pendingOperation() {
  const thread = (
    await pool.query(
      "SELECT id, last_activity_at FROM threads WHERE status = 'active' AND NOT historical ORDER BY display_id LIMIT 1",
    )
  ).rows[0];
  const label = (
    await pool.query(
      `INSERT INTO labels (workspace_id, unit_id, thread_id, domain_id, type, tense, evidence_message_ids, confidence, vocab_version)
    SELECT workspace_id, unit_id, $2, domain_id, type, tense, evidence_message_ids, confidence, vocab_version FROM labels WHERE workspace_id = $1 AND id = md5('point-star-label-1')::uuid RETURNING id, op_id, evidence_message_ids`,
      [seed.workspaceId, thread.id],
    )
  ).rows[0];

  await scopedTransaction(services.resolveConnection, seed.workspaceId, async (tx) => {
    await recordProgress(
      tx,
      { workspaceId: seed.workspaceId, threadId: thread.id },
      {
        opId: label.op_id,
        type: 'progress',
        messageId: label.evidence_message_ids[0],
        now: instant,
      },
    );
  });
  const notification = (
    await pool.query(
      `INSERT INTO notifications (workspace_id, label_id, thread_id, recipient_person_id, kind, channel, body_rendered, held_until, sent_at)
    VALUES ($1, $2, $3, md5('point-star-person-2')::uuid, 'update', 'telegram', 'Confirmed update', $4, $4) RETURNING id, recipient_person_id`,
      [seed.workspaceId, label.id, thread.id, instant],
    )
  ).rows[0];

  await pool.query(
    `INSERT INTO notifications (workspace_id, label_id, thread_id, recipient_person_id, kind, channel, body_rendered, held_until)
    VALUES ($1, $2, $3, md5('point-star-person-2')::uuid, 'reminder', 'telegram', 'Still going?', $4)`,
    [seed.workspaceId, label.id, thread.id, services.now()],
  );

  return { thread, label, notification };
}

test.each(['resolution', 'progress', 'blocker'] as const)(
  'FR-UI-03: %s status feedback records progress and stops or resets reminders',
  async (type) => {
    const { thread, label, notification } = await pendingOperation();
    const input = {
      workspaceId: seed.workspaceId,
      notificationId: notification.id,
      opId: label.op_id,
      actorId: notification.recipient_person_id,
      type,
      confirmationId: 'callback-1',
    };

    await recordStatus(services, input);
    await recordStatus(services, input);
    const updated = (
      await pool.query('SELECT status, last_activity_at FROM threads WHERE id = $1', [thread.id])
    ).rows[0];

    expect(updated.status).toBe(type === 'resolution' ? 'completed' : 'active');
    expect(updated.last_activity_at).toEqual(services.now());
    expect(
      (
        await pool.query(
          "SELECT cancelled_at FROM notifications WHERE label_id = $1 AND kind = 'reminder'",
          [label.id],
        )
      ).rows[0].cancelled_at,
    ).toEqual(services.now());
    expect(
      (
        await pool.query('SELECT type, confirmed_by FROM progress_markers WHERE op_id = $1', [
          label.op_id,
        ])
      ).rows,
    ).toEqual([{ type, confirmed_by: input.actorId }]);
    await scopedTransaction(services.resolveConnection, seed.workspaceId, async (tx) => {
      await rollback(
        tx,
        { workspaceId: seed.workspaceId, threadId: thread.id },
        { opId: label.op_id, now: services.now() },
      );
    });
    expect(
      (await pool.query('SELECT status, last_activity_at FROM threads WHERE id = $1', [thread.id]))
        .rows[0],
    ).toMatchObject({ status: 'active', last_activity_at: thread.last_activity_at });
  },
);
