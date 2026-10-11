import { beforeAll, expect, test, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { pointStarSeed, loadPointStarSeed } from '../../../fixtures/point-star.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { runStaleness } from '../../../../src/features/delivery/delivery-staleness.service.js';
import { recordStatus } from '../../../../src/features/delivery/delivery-status.service.js';
import { sendNotification } from '../../../../src/features/delivery/delivery-send.service.js';
import { createSecretStore } from '../../../../src/platform/secrets/index.js';
import { createProviderRegistry } from '../../../../src/platform/providers/index.js';
import { createFakeProvider } from '../../../helpers/providers/fake.js';
import { reminderRecipient } from '../../../../src/features/people/index.js';

const pool = databaseFixture(3);
let now = new Date('2026-10-10T04:00:00Z');
const seed = pointStarSeed({ now: () => now });
const publish = vi.fn(
  async (
    _tx: PoolClient,
    _scope: { workspaceId: string; notificationId: string },
    _heldUntil: Date,
  ) => 'queued',
);
const services = {
  resolveConnection: createConnectionResolver(pool),
  now: () => now,
  publishNotification: publish,
};
const scope = { workspaceId: seed.workspaceId };
const secretStore = createSecretStore(Buffer.alloc(32, 5).toString('base64'));
const exchange = vi.fn(async (_payload: unknown) => {});
let target: { id: string; owner: string; manager: string };

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
  await pool.query('DELETE FROM notifications WHERE workspace_id = $1', [seed.workspaceId]);
  await pool.query('UPDATE threads SET last_activity_at = $2 WHERE workspace_id = $1', [
    seed.workspaceId,
    now,
  ]);
  target = (
    await pool.query(
      `SELECT t.id, t.owner_person_id AS owner, p.manager_id AS manager FROM threads t
    JOIN people p ON p.id = t.owner_person_id WHERE t.workspace_id = $1 AND t.display_id = 'ORD-0091'`,
      [seed.workspaceId],
    )
  ).rows[0];
  await pool.query(
    "UPDATE threads SET status = 'active', historical = false, last_activity_at = $2::timestamptz - interval '13 hours' WHERE id = $1",
    [target.id, now],
  );
  const tx = await pool.connect();

  try {
    const token = await secretStore.put(tx, seed.workspaceId, {
      purpose: 'bot_token',
      value: 'test-token',
    });

    await tx.query('UPDATE bot_connections SET token_secret_ref = $2 WHERE workspace_id = $1', [
      seed.workspaceId,
      token,
    ]);
  } finally {
    tx.release();
  }
}, 120000);

test('SRS §8.5: silent active work gets one owner reminder under concurrent scheduler runs', async () => {
  await Promise.all([runStaleness(services, scope), runStaleness(services, scope)]);
  const rows = (
    await pool.query(
      'SELECT kind, recipient_person_id, label_id FROM notifications WHERE thread_id = $1',
      [target.id],
    )
  ).rows;

  expect(rows).toEqual([{ kind: 'reminder', recipient_person_id: target.owner, label_id: null }]);
  expect(publish).toHaveBeenCalledTimes(1);
  const policy = (
    await pool.query('SELECT hold_seconds FROM policies WHERE workspace_id = $1', [
      seed.workspaceId,
    ])
  ).rows[0];

  expect(publish.mock.calls[0][2]).toEqual(new Date(now.getTime() + policy.hold_seconds * 1000));
});

test('SRS §8.5: three days without an answer yields one supervisor escalation and never a second', async () => {
  await pool.query(
    "UPDATE notifications SET sent_at = $2 WHERE thread_id = $1 AND kind = 'reminder'",
    [target.id, now],
  );
  now = new Date(now.getTime() + 3 * 86400000);
  await runStaleness(services, scope);
  await runStaleness(services, scope);
  const rows = (
    await pool.query(
      "SELECT recipient_person_id FROM notifications WHERE thread_id = $1 AND kind = 'escalation'",
      [target.id],
    )
  ).rows;

  expect(rows).toEqual([{ recipient_person_id: target.manager }]);
});

test('SRS §8.5: progress resets the silence cycle and permits one fresh reminder', async () => {
  await pool.query('UPDATE threads SET last_activity_at = $2 WHERE id = $1', [target.id, now]);
  await runStaleness(services, scope);
  expect(
    (
      await pool.query("SELECT id FROM notifications WHERE thread_id = $1 AND kind = 'reminder'", [
        target.id,
      ])
    ).rowCount,
  ).toBe(1);
  now = new Date(now.getTime() + 25 * 3600000);
  await runStaleness(services, scope);
  expect(
    (
      await pool.query("SELECT id FROM notifications WHERE thread_id = $1 AND kind = 'reminder'", [
        target.id,
      ])
    ).rowCount,
  ).toBe(2);
});

test('SRS §8.5: an owner answer to a label-free reminder resets silence and cancels pending escalation', async () => {
  const reminder = (
    await pool.query(
      "SELECT id, held_until FROM notifications WHERE thread_id = $1 AND kind = 'reminder' AND stale_since = (SELECT last_activity_at FROM threads WHERE id = $1)",
      [target.id],
    )
  ).rows[0];

  now = reminder.held_until;
  await sendNotification(
    {
      ...services,
      secretStore,
      providers: createProviderRegistry([
        { ...createFakeProvider(exchange), provider: 'telegram' },
      ]),
      publicBaseUrl: 'https://simpul.example',
    },
    { workspaceId: seed.workspaceId, notificationId: reminder.id },
  );
  expect(exchange).toHaveBeenCalledTimes(1);
  expect((exchange.mock.calls[0][0] as { content: string }).content).toContain(
    '3. There is a blocker',
  );
  expect((exchange.mock.calls[0][0] as { content: string }).content).not.toContain('Not this work');
  now = new Date(now.getTime() + 1000);
  await recordStatus(services, {
    workspaceId: seed.workspaceId,
    notificationId: reminder.id,
    opId: reminder.id,
    actorId: target.owner,
    type: 'progress',
    confirmationId: 'owner-answer',
  });
  expect(
    (await pool.query('SELECT last_activity_at FROM threads WHERE id = $1', [target.id])).rows[0]
      .last_activity_at,
  ).toEqual(now);
  expect(
    (
      await pool.query(
        "SELECT confirmed_by, message_id, op_id FROM progress_markers WHERE confirmation_id = 'owner-answer'",
      )
    ).rows[0],
  ).toEqual({ confirmed_by: target.owner, message_id: null, op_id: null });
});

test('SRS §8.3: an owner on leave is replaced by the role backup before the supervisor or admin', async () => {
  const backup = (
    await pool.query(
      `SELECT id FROM people WHERE workspace_id = $1 AND active
    AND availability = 'available' AND id <> ALL($2::uuid[])
    AND id <> (SELECT admin_person_id FROM workspaces WHERE id = $1) ORDER BY id LIMIT 1`,
      [seed.workspaceId, [target.owner, target.manager]],
    )
  ).rows[0].id;
  const role = (
    await pool.query(
      "SELECT role_id FROM role_members WHERE person_id = $1 AND kind = 'member' ORDER BY role_id LIMIT 1",
      [target.owner],
    )
  ).rows[0].role_id;

  await pool.query("DELETE FROM role_members WHERE role_id = $1 AND kind = 'backup'", [role]);
  await pool.query(
    "INSERT INTO role_members (workspace_id, role_id, person_id, kind) VALUES ($1, $2, $3, 'backup')",
    [seed.workspaceId, role, backup],
  );
  await pool.query("UPDATE people SET availability = 'leave' WHERE id = $1", [target.owner]);
  const tx = await pool.connect();

  try {
    expect(
      await reminderRecipient(tx, seed.workspaceId, { ownerId: target.owner, supervisor: false }),
    ).toBe(backup);
  } finally {
    tx.release();
  }
});

test('SRS §8.3: reminder delivery re-resolves an owner who went on leave during the hold', async () => {
  await pool.query("UPDATE people SET availability = 'available' WHERE id = $1", [target.owner]);
  now = new Date(now.getTime() + 25 * 3600000);
  await runStaleness(services, scope);
  const reminder = (
    await pool.query(
      `SELECT id, held_until FROM notifications WHERE thread_id = $1
    AND kind = 'reminder' AND sent_at IS NULL AND cancelled_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [target.id],
    )
  ).rows[0];

  await pool.query("UPDATE people SET availability = 'leave' WHERE id = $1", [target.owner]);
  now = reminder.held_until;
  exchange.mockClear();
  await sendNotification(
    {
      ...services,
      secretStore,
      providers: createProviderRegistry([
        { ...createFakeProvider(exchange), provider: 'telegram' },
      ]),
      publicBaseUrl: 'https://simpul.example',
    },
    { workspaceId: seed.workspaceId, notificationId: reminder.id },
  );
  const destination = (
    await pool.query('SELECT recipient_person_id FROM notifications WHERE id = $1', [reminder.id])
  ).rows[0];

  expect(destination.recipient_person_id).not.toBe(target.owner);
  expect(exchange).toHaveBeenCalledTimes(1);
});
