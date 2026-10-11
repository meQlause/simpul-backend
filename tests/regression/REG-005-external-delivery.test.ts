import { beforeAll, expect, test, vi } from 'vitest';
import { databaseFixture } from '../helpers/database.js';
import { applyMigrations } from '../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../fixtures/point-star.js';
import { createConnectionResolver } from '../../src/platform/db/connection-resolver.js';
import { createSecretStore } from '../../src/platform/secrets/index.js';
import { createProviderRegistry } from '../../src/platform/providers/index.js';
import { createFakeProvider } from '../helpers/providers/fake.js';
import { routeLabel } from '../../src/features/delivery/delivery-routing.service.js';
import { sendNotification } from '../../src/features/delivery/delivery-send.service.js';
import { renderNotification } from '../../src/features/delivery/delivery.rules.js';

const pool = databaseFixture();
const instant = new Date('2026-10-10T04:00:00Z');
const seed = pointStarSeed({ now: () => instant });
const exchange = vi.fn(async (_payload: unknown) => {});
const secretStore = createSecretStore(Buffer.alloc(32, 5).toString('base64'));
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
    "UPDATE channels SET class = 'external' WHERE id = md5('point-star-channel-2')::uuid",
  );
}, 120000);

test('REG-005 / SRS T-10: external sending always renders the fixed template, even if a held body is unsafe', async () => {
  const labelId = (
    await pool.query(
      `INSERT INTO labels (workspace_id, unit_id, thread_id, domain_id, type, tense, evidence_message_ids, confidence, vocab_version, created_at)
    SELECT workspace_id, unit_id, thread_id, domain_id, type, tense, evidence_message_ids, confidence, vocab_version, $2
    FROM labels WHERE workspace_id = $1 AND id = md5('point-star-label-1')::uuid RETURNING id`,
      [seed.workspaceId, instant],
    )
  ).rows[0].id as string;

  await routeLabel({ ...services, now: () => instant }, { workspaceId: seed.workspaceId, labelId });
  const fields = (
    await pool.query(
      `SELECT t.display_id AS work_id, coalesce(t.customer_label, '') AS customer, t.summary
    FROM threads t JOIN labels l ON l.thread_id = t.id WHERE l.id = $1`,
      [labelId],
    )
  ).rows[0];
  const template = (
    await pool.query(
      "SELECT body FROM templates WHERE workspace_id = $1 AND audience = 'external' AND key = 'update'",
      [seed.workspaceId],
    )
  ).rows[0].body as string;
  const expected = renderNotification(template, fields);
  const notifications = (
    await pool.query('SELECT id, body_rendered FROM notifications WHERE label_id = $1', [labelId])
  ).rows as { id: string; body_rendered: string }[];

  expect(notifications.length).toBeGreaterThan(0);
  expect(notifications.every((row) => row.body_rendered === expected)).toBe(true);
  await pool.query(
    "UPDATE notifications SET body_rendered = 'cost=999 margin=88 internal_note=secret' WHERE label_id = $1",
    [labelId],
  );

  for (const notification of notifications) {
    await sendNotification(services, {
      workspaceId: seed.workspaceId,
      notificationId: notification.id,
    });
  }

  expect(exchange).toHaveBeenCalledTimes(notifications.length);
  expect(
    exchange.mock.calls.every(([payload]) => (payload as { content: string }).content === expected),
  ).toBe(true);
  expect(
    (
      await pool.query('SELECT body_rendered FROM notifications WHERE label_id = $1', [labelId])
    ).rows.every((row: { body_rendered: string }) => row.body_rendered === expected),
  ).toBe(true);
});
