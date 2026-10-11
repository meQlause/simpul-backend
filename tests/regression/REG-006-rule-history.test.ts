import { beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import { databaseFixture, createConnectionResolver } from '../helpers/database-mode.js';
import { applyMigrations } from '../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../fixtures/point-star.js';
import { signInSeedAdmin } from '../helpers/admin-session.js';
import { createApp } from '../../src/app.js';
import { randomUUID } from 'node:crypto';

const pool = databaseFixture();
const instant = new Date('2026-10-10T04:01:00Z');
const seed = pointStarSeed({ now: () => instant });
let app: ReturnType<typeof createApp>;
let cookie: string;
let ruleInput: {
  name: string;
  categoryId: string;
  eventType: string;
  conditionText: string;
  recipientRoleId: string;
};

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
  const session = await signInSeedAdmin(pool, {
    id: 'history-admin',
    email: 'history@pointstar.example',
  });

  cookie = session.cookie;
  app = createApp('api', undefined, undefined, {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
    rules: { now: () => instant },
  });
  const references = (
    await pool.query(
      'SELECT domain_id, recipient_role_id FROM rules WHERE workspace_id = $1 ORDER BY created_at, id LIMIT 1',
      [seed.workspaceId],
    )
  ).rows[0];

  ruleInput = {
    name: 'Past progress digest',
    categoryId: references.domain_id,
    eventType: 'progress',
    conditionText: 'Confirmed updates',
    recipientRoleId: references.recipient_role_id,
  };
  await pool.query('UPDATE threads SET historical = true WHERE workspace_id = $1', [
    seed.workspaceId,
  ]);
}, 120000);

test('REG-006 / Rules §2: saving historyMode digest gathers past labels into one digest and creates no per-event notifications', async () => {
  const before = (await pool.query('SELECT count(*)::int AS total FROM notifications')).rows[0]
    .total;
  const response = await request(app)
    .post('/api/v1/rules')
    .set('Cookie', cookie)
    .send({ ...ruleInput, historyMode: 'digest' });

  expect(response.status).toBe(201);
  expect(response.body.data).toMatchObject({
    name: ruleInput.name,
    historyMode: 'digest',
    active: true,
  });
  expect((await pool.query('SELECT count(*)::int AS total FROM notifications')).rows[0].total).toBe(
    before,
  );
  const items = await pool.query(
    'SELECT count(*)::int AS total, count(DISTINCT digest_id)::int AS digests FROM digest_items WHERE workspace_id = $1 AND rule_id = $2',
    [seed.workspaceId, response.body.data.id],
  );

  expect(items.rows[0].total).toBeGreaterThan(0);
  expect(items.rows[0].digests).toBe(1);
});

test('REG-006 / Rules §2: historyMode future creates no historical delivery work', async () => {
  const before = (await pool.query('SELECT count(*)::int AS total FROM notifications')).rows[0]
    .total;
  const response = await request(app)
    .post('/api/v1/rules')
    .set('Cookie', cookie)
    .send({ ...ruleInput, historyMode: 'future' });

  expect(response.status).toBe(201);
  expect((await pool.query('SELECT count(*)::int AS total FROM notifications')).rows[0].total).toBe(
    before,
  );
  expect(
    (
      await pool.query('SELECT count(*)::int AS total FROM digest_items WHERE rule_id = $1', [
        response.body.data.id,
      ])
    ).rows[0].total,
  ).toBe(0);
});

test('REG-006 / Rules §3: repeated digest edits reuse history items and pausing writes only configuration', async () => {
  const creation = await request(app)
    .post('/api/v1/rules')
    .set('Cookie', cookie)
    .send({ ...ruleInput, historyMode: 'digest' });
  const before = (await pool.query('SELECT count(*)::int AS total FROM digest_items')).rows[0]
    .total;
  const response = await request(app)
    .patch(`/api/v1/rules/${creation.body.data.id}`)
    .set('Cookie', cookie)
    .send({ historyMode: 'digest' });

  expect(response.status).toBe(200);
  expect((await pool.query('SELECT count(*)::int AS total FROM digest_items')).rows[0].total).toBe(
    before,
  );
  const paused = await request(app)
    .patch(`/api/v1/rules/${creation.body.data.id}`)
    .set('Cookie', cookie)
    .send({ active: false });

  expect(paused.status).toBe(200);
  expect(paused.body.data.active).toBe(false);
});

test('Rules §2: no matching history creates no empty digest', async () => {
  const before = (await pool.query('SELECT count(*)::int AS total FROM digests')).rows[0].total;
  const event = (
    await pool.query(
      `SELECT event FROM unnest(ARRAY['resolution','blocker']) event WHERE NOT EXISTS
    (SELECT 1 FROM labels WHERE workspace_id = $1 AND domain_id = $2 AND type = event) LIMIT 1`,
      [seed.workspaceId, ruleInput.categoryId],
    )
  ).rows[0].event as string;
  const response = await request(app)
    .post('/api/v1/rules')
    .set('Cookie', cookie)
    .send({ ...ruleInput, eventType: event });

  expect(response.status).toBe(201);
  expect((await pool.query('SELECT count(*)::int AS total FROM digests')).rows[0].total).toBe(
    before,
  );
});

test('Rules §2: resolving an unknown review item rolls back rule creation', async () => {
  const before = (await pool.query('SELECT count(*)::int AS total FROM rules')).rows[0].total;
  const response = await request(app)
    .post('/api/v1/rules')
    .set('Cookie', cookie)
    .send({ ...ruleInput, reviewItemId: randomUUID() });

  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe('E-VALIDATION');
  expect((await pool.query('SELECT count(*)::int AS total FROM rules')).rows[0].total).toBe(before);
});

test('Rules §2: saving from an open unrouted review item resolves it in the same transaction', async () => {
  const review = (
    await pool.query(
      "SELECT id FROM review_items WHERE workspace_id = $1 AND kind = 'unrouted' AND resolved_at IS NULL LIMIT 1",
      [seed.workspaceId],
    )
  ).rows[0];
  const response = await request(app)
    .post('/api/v1/rules')
    .set('Cookie', cookie)
    .send({ ...ruleInput, historyMode: 'future', reviewItemId: review.id });

  expect(response.status).toBe(201);
  expect(
    (await pool.query('SELECT resolved_at FROM review_items WHERE id = $1', [review.id])).rows[0]
      .resolved_at,
  ).toEqual(instant);
});

test('Rules §§2–3: saves require authentication and validate server-owned fields and route ids', async () => {
  expect((await request(app).post('/api/v1/rules').send(ruleInput)).status).toBe(401);
  expect(
    (
      await request(app)
        .post('/api/v1/rules')
        .set('Cookie', cookie)
        .send({ ...ruleInput, priority: 99 })
    ).status,
  ).toBe(422);
  expect(
    (
      await request(app)
        .patch('/api/v1/rules/invalid')
        .set('Cookie', cookie)
        .send({ active: false })
    ).status,
  ).toBe(422);
});
