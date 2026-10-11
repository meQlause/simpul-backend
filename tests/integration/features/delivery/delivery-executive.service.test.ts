import { beforeAll, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { routeLabel } from '../../../../src/features/delivery/delivery-routing.service.js';
import { sendNotification } from '../../../../src/features/delivery/delivery-send.service.js';
import { createSecretStore } from '../../../../src/platform/secrets/index.js';
import { createProviderRegistry } from '../../../../src/platform/providers/index.js';
import { createFakeProvider } from '../../../helpers/providers/fake.js';

const pool = databaseFixture();
const now = new Date('2026-10-10T04:00:00Z');
const seed = pointStarSeed({ now: () => now });
const publish = vi.fn();
const services = {
  resolveConnection: createConnectionResolver(pool),
  now: () => now,
  publishNotification: publish,
};
let labelId: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
  await pool.query('DELETE FROM notifications WHERE workspace_id = $1', [seed.workspaceId]);
  await pool.query('UPDATE rules SET active = false WHERE workspace_id = $1', [seed.workspaceId]);
  await pool.query(
    `INSERT INTO rules (workspace_id, name, domain_id, condition_text, event_type, recipient_role_id, template_id, urgency)
    VALUES ($1, 'Executive progress', md5('point-star-domain-Order')::uuid, 'Confirmed progress', 'progress',
      md5('point-star-role-2')::uuid, md5('point-star-template-internal')::uuid, 'high')`,
    [seed.workspaceId],
  );
  labelId = (
    await pool.query(
      `INSERT INTO labels (workspace_id, unit_id, thread_id, domain_id, type, tense,
    evidence_message_ids, confidence, vocab_version, created_at)
    VALUES ($1, md5('point-star-unit-1000')::uuid, md5('point-star-thread-ORD-0091')::uuid,
      md5('point-star-domain-Order')::uuid, 'progress', 'sudah_terjadi', ARRAY[md5('point-star-message-1000')::uuid], 0.95, 1, $2) RETURNING id`,
      [seed.workspaceId, now],
    )
  ).rows[0].id;
}, 30000);

test('SRS §8.5: an executive receives a digest, never a single notification even for a high urgency event', async () => {
  await pool.query(
    "UPDATE people SET level = 'executive' WHERE id = md5('point-star-person-2')::uuid",
  );
  await routeLabel(services, { workspaceId: seed.workspaceId, labelId });
  const notification = (
    await pool.query('SELECT digest_id, sent_at FROM notifications WHERE label_id = $1', [labelId])
  ).rows[0];

  expect(notification.digest_id).not.toBeNull();
  expect(notification.sent_at).toBeNull();
  expect(publish).not.toHaveBeenCalled();
});

test('SRS §8.5: a held notification to a person who became executive is moved into a digest before sending', async () => {
  await pool.query('UPDATE notifications SET digest_id = NULL WHERE label_id = $1', [labelId]);
  const notification = (
    await pool.query('SELECT id, held_until FROM notifications WHERE label_id = $1', [labelId])
  ).rows[0];
  const exchange = vi.fn();

  await sendNotification(
    {
      ...services,
      now: () => notification.held_until,
      secretStore: {
        ...createSecretStore(Buffer.alloc(32, 5).toString('base64')),
        get: vi.fn(async () => 'test-token'),
      },
      providers: createProviderRegistry([
        { ...createFakeProvider(exchange), provider: 'telegram' },
      ]),
      publicBaseUrl: 'https://simpul.example',
    },
    { workspaceId: seed.workspaceId, notificationId: notification.id },
  );
  expect(exchange).not.toHaveBeenCalled();
  expect(
    (
      await pool.query('SELECT digest_id, sent_at FROM notifications WHERE id = $1', [
        notification.id,
      ])
    ).rows[0],
  ).toMatchObject({ digest_id: expect.any(String), sent_at: null });
});
