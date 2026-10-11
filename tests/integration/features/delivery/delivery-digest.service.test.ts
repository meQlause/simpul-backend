import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { createSecretStore } from '../../../../src/platform/secrets/index.js';
import { runDigests } from '../../../../src/features/delivery/delivery-digest.service.js';
import { getMail } from '../../../../src/features/workspace/workspace-mail.service.js';
import { budgetDigest } from '../../../../src/features/delivery/delivery-budget.service.js';

const pool = databaseFixture(3);
let now = new Date('2026-10-10T01:29:00Z');
const seed = pointStarSeed({ now: () => now });
const secretStore = createSecretStore(Buffer.alloc(32, 5).toString('base64'));
const sendMail = vi.fn(async (_credentials: unknown, _message: unknown) => {});
const services = {
  resolveConnection: createConnectionResolver(pool),
  now: () => now,
  secretStore,
  sendMail,
};
const scope = { workspaceId: seed.workspaceId };
let digestId: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
}, 30000);

beforeEach(async () => {
  now = new Date('2026-10-10T01:29:00Z');
  sendMail.mockReset();
  await pool.query('DELETE FROM digests WHERE workspace_id = $1', [seed.workspaceId]);
  await pool.query('DELETE FROM mail_connections WHERE workspace_id = $1', [seed.workspaceId]);
  await pool.query("DELETE FROM decisions WHERE workspace_id = $1 AND kind = 'digest'", [
    seed.workspaceId,
  ]);
  digestId = (
    await pool.query(
      `INSERT INTO digests (workspace_id, recipient_person_id, scheduled_for)
    SELECT $1, id, $2::timestamptz + interval '1 minute' FROM people WHERE workspace_id = $1 AND level = 'executive' RETURNING id`,
      [seed.workspaceId, now],
    )
  ).rows[0].id;
  await pool.query(
    `UPDATE notifications SET digest_id = $2, sent_at = NULL, held_until = $3
    WHERE workspace_id = $1 AND recipient_person_id IN (SELECT id FROM people WHERE workspace_id = $1 AND level = 'executive')`,
    [seed.workspaceId, digestId, now],
  );
});

async function configureMail() {
  const tx = await pool.connect();

  try {
    const passwordRef = await secretStore.put(tx, seed.workspaceId, {
      purpose: 'mail_password',
      value: 'smtp-test-password',
    });

    await tx.query(
      `INSERT INTO mail_connections (workspace_id, host, port, username, from_address, password_secret_ref, verified_at)
      VALUES ($1, 'smtp.example.test', 587, 'simpul', 'simpul@example.test', $2, $3)`,
      [seed.workspaceId, passwordRef, now],
    );
  } finally {
    tx.release();
  }
}

test('B-7: without a mail server a due digest stays pending, uses no alternate channel, and mail settings reports four waiting items', async () => {
  now = new Date('2026-10-10T01:30:00Z');
  await runDigests(services, scope);
  expect(sendMail).not.toHaveBeenCalled();
  expect(
    (await pool.query('SELECT sent_at FROM digests WHERE id = $1', [digestId])).rows[0].sent_at,
  ).toBeNull();
  expect(await getMail(services.resolveConnection, seed.workspaceId)).toEqual({
    data: null,
    pendingDigestItems: 4,
  });
});

test('SRS §8.5: the email digest sends once at 08:30 workspace time, not before, with a digest decision', async () => {
  await configureMail();
  await runDigests(services, scope);
  expect(sendMail).not.toHaveBeenCalled();
  now = new Date('2026-10-10T01:30:00Z');
  await Promise.all([runDigests(services, scope), runDigests(services, scope)]);
  await runDigests(services, scope);
  expect(sendMail).toHaveBeenCalledTimes(1);
  expect(sendMail.mock.calls[0][0]).toMatchObject({
    host: 'smtp.example.test',
    password: 'smtp-test-password',
  });
  expect(sendMail.mock.calls[0][1]).toMatchObject({
    to: 'hendra@example.test',
    text: expect.stringContaining('Sample order update 1'),
  });
  expect(
    (await pool.query('SELECT sent_at FROM digests WHERE id = $1', [digestId])).rows[0].sent_at,
  ).toEqual(now);
  expect(
    (
      await pool.query("SELECT id FROM decisions WHERE workspace_id = $1 AND kind = 'digest'", [
        seed.workspaceId,
      ])
    ).rowCount,
  ).toBe(1);
});

test('B-7: waiting items send after mail is configured; an SMTP failure leaves them available for retry', async () => {
  now = new Date('2026-10-10T01:30:00Z');
  await runDigests(services, scope);
  await configureMail();
  sendMail.mockRejectedValueOnce(new Error('SMTP unavailable'));
  await expect(runDigests(services, scope)).rejects.toThrow('SMTP unavailable');
  expect(
    (await pool.query('SELECT sent_at FROM digests WHERE id = $1', [digestId])).rows[0].sent_at,
  ).toBeNull();
  await runDigests(services, scope);
  expect(
    (await pool.query('SELECT sent_at FROM digests WHERE id = $1', [digestId])).rows[0].sent_at,
  ).toEqual(now);
});

test('B-7: the waiting count includes active historical digest items without creating event notifications', async () => {
  const before = (
    await pool.query('SELECT id FROM notifications WHERE workspace_id = $1', [seed.workspaceId])
  ).rowCount;

  await pool.query(
    `INSERT INTO digest_items (workspace_id, digest_id, label_id, rule_id)
    VALUES ($1, $2, md5('point-star-order-label-1')::uuid, md5('point-star-rule-1')::uuid)`,
    [seed.workspaceId, digestId],
  );
  expect(await getMail(services.resolveConnection, seed.workspaceId)).toEqual({
    data: null,
    pendingDigestItems: 5,
  });
  await configureMail();
  now = new Date('2026-10-10T01:30:00Z');
  await runDigests(services, scope);
  expect(sendMail.mock.calls[0][1]).toMatchObject({ text: expect.stringContaining('ORD-') });
  expect(
    (await pool.query('SELECT id FROM notifications WHERE workspace_id = $1', [seed.workspaceId]))
      .rowCount,
  ).toBe(before);
});

test('SRS §8.5: scheduling converts digestTime with the workspace timezone rather than the server timezone', async () => {
  await pool.query('DELETE FROM digests WHERE workspace_id = $1', [seed.workspaceId]);
  await pool.query("UPDATE workspaces SET timezone = 'Asia/Tokyo' WHERE id = $1", [
    seed.workspaceId,
  ]);
  now = new Date('2026-10-09T23:29:00Z');
  const personId = (
    await pool.query("SELECT id FROM people WHERE workspace_id = $1 AND level = 'executive'", [
      seed.workspaceId,
    ])
  ).rows[0].id;
  const tx = await pool.connect();

  try {
    const id = await budgetDigest(tx, { workspaceId: seed.workspaceId, personId }, now, 'high');

    expect(
      (await tx.query('SELECT scheduled_for FROM digests WHERE id = $1', [id])).rows[0]
        .scheduled_for,
    ).toEqual(new Date('2026-10-09T23:30:00Z'));
  } finally {
    tx.release();
    await pool.query("UPDATE workspaces SET timezone = 'Asia/Jakarta' WHERE id = $1", [
      seed.workspaceId,
    ]);
  }
});

test('SRS §8.4: an item still in its correction hold moves to the next digest instead of being stranded in a sent one', async () => {
  await configureMail();
  await pool.query(
    `UPDATE notifications SET held_until = '2026-10-10T01:31:00Z'
    WHERE id = (SELECT id FROM notifications WHERE digest_id = $1 ORDER BY id LIMIT 1)`,
    [digestId],
  );
  now = new Date('2026-10-10T01:30:00Z');
  await runDigests(services, scope);
  const waiting = (
    await pool.query(
      `SELECT d.sent_at, d.scheduled_for FROM notifications n JOIN digests d ON d.id = n.digest_id
    WHERE n.workspace_id = $1 AND n.sent_at IS NULL AND n.held_until > $2`,
      [seed.workspaceId, now],
    )
  ).rows;

  expect(waiting).toEqual([{ sent_at: null, scheduled_for: new Date('2026-10-11T01:30:00Z') }]);
});
