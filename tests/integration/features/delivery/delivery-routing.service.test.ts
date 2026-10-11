import { beforeAll, expect, test } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import { routeLabel } from '../../../../src/features/delivery/delivery-routing.service.js';

const pool = databaseFixture(4);
const now = new Date('2026-10-10T04:01:00Z');
const seed = pointStarSeed({ now: () => now });
let labelId: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
  await pool.query('UPDATE rules SET active = false WHERE workspace_id = $1', [seed.workspaceId]);
  await pool.query(
    `INSERT INTO rules (workspace_id, name, domain_id, condition_text, event_type,
      recipient_role_id, template_id, urgency)
    SELECT $1, 'Merge rule ' || num, md5('point-star-domain-Order')::uuid, 'Confirmed progress',
      'progress', md5('point-star-role-2')::uuid, md5('point-star-template-internal')::uuid,
      CASE WHEN num = 2 THEN 'high' ELSE 'normal' END FROM generate_series(1, 3) num`,
    [seed.workspaceId],
  );
  labelId = (
    await pool.query(
      `INSERT INTO labels (workspace_id, unit_id, thread_id, domain_id, type, tense,
      evidence_message_ids, confidence, vocab_version, created_at)
    VALUES ($1, md5('point-star-unit-1000')::uuid, md5('point-star-thread-ORD-0091')::uuid,
      md5('point-star-domain-Order')::uuid, 'progress', 'sudah_terjadi',
      ARRAY[md5('point-star-message-1000')::uuid], 0.95, 1, $2) RETURNING id`,
      [seed.workspaceId, now],
    )
  ).rows[0].id;
}, 120000);

test('Delivery L5.3–5.4: three matching rules for one person produce one notification at the highest urgency', async () => {
  await routeLabel(
    { resolveConnection: createConnectionResolver(pool), now: () => now },
    { workspaceId: seed.workspaceId, labelId },
  );
  const notifications = await pool.query(
    `SELECT n.held_until, p.name, r.urgency FROM notifications n
    JOIN people p ON p.id = n.recipient_person_id JOIN rules r ON r.id = n.rule_id
    WHERE n.label_id = $1`,
    [labelId],
  );

  expect(notifications.rows).toHaveLength(1);
  expect(notifications.rows[0]).toMatchObject({
    name: 'Budi Santoso',
    urgency: 'high',
    held_until: new Date('2026-10-10T04:02:00Z'),
  });
  expect(
    (await pool.query('SELECT * FROM label_rule_matches WHERE label_id = $1', [labelId])).rows,
  ).toHaveLength(3);
});

test('Delivery concurrency: two workers routing one label produce one notification per recipient', async () => {
  await pool.query(
    `INSERT INTO rules (workspace_id, name, domain_id, condition_text, event_type,
      recipient_role_id, template_id, urgency)
    SELECT workspace_id, 'Concurrent sales recipient', domain_id, condition_text, event_type,
      md5('point-star-role-3')::uuid, template_id, urgency
    FROM rules WHERE name = 'Merge rule 2' AND workspace_id = $1`,
    [seed.workspaceId],
  );
  const freshLabel = (
    await pool.query(
      `INSERT INTO labels (workspace_id, unit_id, thread_id, domain_id, type, tense,
      evidence_message_ids, confidence, vocab_version, created_at)
    SELECT workspace_id, unit_id, thread_id, domain_id, type, tense,
      evidence_message_ids, confidence, vocab_version, created_at
    FROM labels WHERE id = $1 RETURNING id`,
      [labelId],
    )
  ).rows[0].id as string;
  const services = { resolveConnection: createConnectionResolver(pool), now: () => now };
  const scope = { workspaceId: seed.workspaceId, labelId: freshLabel };

  await Promise.all([routeLabel(services, scope), routeLabel(services, scope)]);

  const notifications = await pool.query(
    'SELECT recipient_person_id FROM notifications WHERE label_id = $1',
    [freshLabel],
  );

  expect(notifications.rows).toHaveLength(2);
  expect(
    new Set(
      notifications.rows.map((row: { recipient_person_id: string }) => row.recipient_person_id),
    ).size,
  ).toBe(2);
  expect(
    (await pool.query('SELECT * FROM label_rule_matches WHERE label_id = $1', [freshLabel])).rows,
  ).toHaveLength(4);
  expect(
    (await pool.query('SELECT routed_at FROM labels WHERE id = $1', [freshLabel])).rows[0]
      .routed_at,
  ).toEqual(now);
});
