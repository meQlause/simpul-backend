import { beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { signInSeedAdmin } from '../../../helpers/admin-session.js';
import { createApp } from '../../../../src/app.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';

const pool = databaseFixture();
const seed = pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') });
const counts = { routing: 2, work: 1, queue: 1, digest: 1 };
let app: ReturnType<typeof createApp>;
let cookie: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
  const session = await signInSeedAdmin(pool, { id: 'audit-admin', email: 'audit@example.test' });

  cookie = session.cookie;
  app = createApp('api', undefined, undefined, {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
  });
}, 120000);

test('Audit §1: GET /decisions returns five seed snapshots and counts 2, 1, 1, 1', async () => {
  const response = await request(app).get('/api/v1/decisions').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data).toHaveLength(5);
  expect(response.body).toMatchObject({ page: { nextCursor: null, total: 5 }, counts });
  expect(response.body.data[0]).toMatchObject({
    kind: 'routing',
    recipient: { name: 'Budi Santoso' },
  });
  expect((await request(app).get('/api/v1/decisions')).status).toBe(401);
});

test('Audit §1: cursors paginate without overlap and cannot be reused with a different filter', async () => {
  const first = await request(app).get('/api/v1/decisions?limit=2').set('Cookie', cookie);
  const second = await request(app)
    .get('/api/v1/decisions')
    .query({ limit: 2, cursor: first.body.page?.nextCursor })
    .set('Cookie', cookie);

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(
    new Set([...first.body.data, ...second.body.data].map((row: { id: string }) => row.id)).size,
  ).toBe(4);
  expect(
    (
      await request(app)
        .get('/api/v1/decisions')
        .query({ kind: 'work', cursor: first.body.page.nextCursor })
        .set('Cookie', cookie)
    ).status,
  ).toBe(422);
  const filtered = await request(app)
    .get('/api/v1/decisions?kind=routing&q=Budi')
    .set('Cookie', cookie);

  expect(filtered.body.counts).toEqual(counts);
  expect(filtered.body.page.total).toBe(1);
  expect((await request(app).get('/api/v1/decisions?limit=101').set('Cookie', cookie)).status).toBe(
    422,
  );
});

test('Audit §2: rule.active is live, snapshots are frozen and neighbours ignore filters', async () => {
  const row = (
    await pool.query(
      'SELECT id, rule_id FROM decisions WHERE workspace_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1',
      [seed.workspaceId],
    )
  ).rows[0];
  const url = `/api/v1/decisions/${row.id}`;
  const before = await request(app).get(url).set('Cookie', cookie);

  expect(before.status).toBe(200);
  expect(before.body.data.rule.active).toBe(true);
  expect(before.body.data.neighbours).toMatchObject({ previousId: null, position: 1, total: 5 });
  expect(before.body.data.work.displayId).toBe('ORD-0098');
  await pool.query("UPDATE rules SET active = false, name = 'Renamed live rule' WHERE id = $1", [
    row.rule_id,
  ]);
  const after = await request(app).get(url).set('Cookie', cookie);

  expect(after.body.data).toMatchObject({
    title: before.body.data.title,
    rule: { active: false, name: 'Renamed live rule' },
  });
  expect(
    (await request(app).get(`/api/v1/decisions/${randomUUID()}`).set('Cookie', cookie)).status,
  ).toBe(404);
  expect(JSON.stringify(after.body)).not.toMatch(
    /body_safe|token_secret_ref|evidence_message_ids/u,
  );
});
