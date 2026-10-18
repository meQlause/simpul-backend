import { beforeAll, expect, test, vi } from 'vitest';
import { databaseFixture, createConnectionResolver } from '../../../helpers/database-mode.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { createSecretStore } from '../../../../src/platform/secrets/index.js';
import { createProviderRegistry } from '../../../../src/platform/providers/index.js';
import { createFakeProvider } from '../../../helpers/providers/fake.js';
import { sendNotification } from '../../../../src/features/delivery/delivery-send.service.js';

const pool = databaseFixture();
const instant = new Date('2026-10-10T04:00:00Z');
const later = new Date(instant.getTime() + 60000);
const seed = pointStarSeed({ now: () => instant });
const secretStore = createSecretStore(Buffer.alloc(32, 5).toString('base64'));
const send = vi.fn(async () => ({ unreachable: true }) as object);
const services = {
  resolveConnection: createConnectionResolver(pool),
  now: () => later,
  providers: createProviderRegistry([
    { ...createFakeProvider(async () => {}), provider: 'telegram', send: send as never },
  ]),
  secretStore,
  publicBaseUrl: 'https://simpul.example',
};
const budi = "md5('point-star-person-2')::uuid";

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
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

  await pool.query(
    `UPDATE person_identities SET external_id = '7002', started_at = $1 WHERE person_id = ${budi}`,
    [instant],
  );
}, 120000);

// A held update to one destination, on its own copy of a seeded label.
async function heldNotification(destination: 'person' | 'channel') {
  const label = (
    await pool.query<{ id: string; thread_id: string; channel_id: string }>(
      `INSERT INTO labels (workspace_id, unit_id, thread_id, domain_id, type, tense, evidence_message_ids, confidence, vocab_version, created_at)
      SELECT workspace_id, unit_id, thread_id, domain_id, type, tense, evidence_message_ids, confidence, vocab_version, $2
      FROM labels WHERE workspace_id = $1 AND id = md5('point-star-label-1')::uuid
      RETURNING id, thread_id, (SELECT channel_id FROM units WHERE id = labels.unit_id) AS channel_id`,
      [seed.workspaceId, instant],
    )
  ).rows[0];

  return (
    await pool.query<{ id: string }>(
      `INSERT INTO notifications (workspace_id, label_id, thread_id, recipient_person_id, destination_channel_id, kind, channel, body_rendered, held_until)
      VALUES ($1, $2, $3, ${destination === 'person' ? budi : 'NULL'}, $4, 'update', 'telegram', 'held', $5)
      RETURNING id`,
      [
        seed.workspaceId,
        label.id,
        label.thread_id,
        destination === 'channel' ? label.channel_id : null,
        instant,
      ],
    )
  ).rows[0].id;
}

test('FR-TG-13: an unreachable person marks the notification failed, clears Start and records a decision', async () => {
  const notificationId = await heldNotification('person');

  await expect(
    sendNotification(services, { workspaceId: seed.workspaceId, notificationId }),
  ).resolves.toBeUndefined();

  expect(
    (
      await pool.query(
        'SELECT failed_at, failure_reason, sent_at FROM notifications WHERE id = $1',
        [notificationId],
      )
    ).rows,
  ).toEqual([{ failed_at: later, failure_reason: 'recipient_unreachable', sent_at: null }]);
  expect(
    (await pool.query(`SELECT started_at FROM person_identities WHERE person_id = ${budi}`)).rows,
  ).toEqual([{ started_at: null }]);
  const decision = await pool.query(
    `SELECT kind, title, detail, recipient_person_id = ${budi} AS budi FROM decisions
    WHERE title = 'Not delivered' ORDER BY occurred_at DESC`,
  );

  expect(decision.rows).toHaveLength(1);
  expect(decision.rows[0]).toMatchObject({ kind: 'routing', budi: true });
  expect(decision.rows[0].detail).toContain('Budi Santoso');

  send.mockClear();
  await sendNotification(services, { workspaceId: seed.workspaceId, notificationId });
  expect(send).not.toHaveBeenCalled();
});

test('FR-TG-13: an unreachable channel destination throws as a refused send did, and is not marked failed', async () => {
  const notificationId = await heldNotification('channel');

  await expect(
    sendNotification(services, { workspaceId: seed.workspaceId, notificationId }),
  ).rejects.toMatchObject({ code: 'E-TG-ACTIVATION-FAILED' });
  expect(
    (await pool.query('SELECT failed_at FROM notifications WHERE id = $1', [notificationId])).rows,
  ).toEqual([{ failed_at: null }]);
});
