import { beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { signInSeedAdmin } from '../../../helpers/admin-session.js';
import { createApp } from '../../../../src/app.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';

const pool = databaseFixture();
const now = new Date('2026-10-10T04:01:00Z');
let app: ReturnType<typeof createApp>;
let cookie: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => now }));
  const session = await signInSeedAdmin(pool, {
    id: 'work-admin',
    email: 'work@pointstar.example',
  });

  cookie = session.cookie;
  app = createApp('api', undefined, undefined, {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
    work: { now: () => now },
  });
});

test('Work detail shows the category rhythm and closure controls without raw chat', async () => {
  const response = await request(app).get('/api/v1/work/ORD-0091').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    displayId: 'ORD-0091',
    status: 'stalled',
    canClose: true,
    canUndoClose: false,
    closure: null,
    rhythm: { typicalHours: 12 },
    owner: { name: 'Budi Santoso', backupName: 'Siti Aminah' },
  });
  expect(Object.keys(response.body.data).sort()).toEqual(
    [
      'displayId',
      'customer',
      'summary',
      'status',
      'category',
      'channel',
      'latestUpdate',
      'rhythm',
      'owner',
      'nextStep',
      'timeline',
      'closure',
      'canClose',
      'canUndoClose',
    ].sort(),
  );
});
test('An expired tentative item is unavailable', async () => {
  await pool.query("UPDATE threads SET expires_at = $1 WHERE display_id = 'ORD-0100'", [now]);
  const response = await request(app).get('/api/v1/work/ORD-0100').set('Cookie', cookie);

  expect(response.status).toBe(404);
  await pool.query(
    "UPDATE threads SET expires_at = $1::timestamptz + interval '24 hours' WHERE display_id = 'ORD-0100'",
    [now],
  );
});
const closure = { closure: 'completed', reason: 'Goods have been delivered.' };

test('POST /work/ORD-0098/close with a four-character reason returns 422', async () => {
  const response = await request(app)
    .post('/api/v1/work/ORD-0098/close')
    .set('Cookie', cookie)
    .send({ ...closure, reason: 'done' });

  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe('E-VALIDATION');
  const { rows } = await pool.query(
    "SELECT status, closed_at FROM threads WHERE display_id = 'ORD-0098'",
  );

  expect(rows[0]).toMatchObject({ status: 'active', closed_at: null });
});
test('Closing an open item returns its detail; closing it again returns E-WORK-NOT-OPEN', async () => {
  const response = await request(app)
    .post('/api/v1/work/ORD-0098/close')
    .set('Cookie', cookie)
    .send(closure);

  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    displayId: 'ORD-0098',
    status: 'completed',
    canClose: false,
    canUndoClose: true,
    closure: {
      kind: 'completed',
      reason: closure.reason,
      closedAt: now.toISOString(),
      closedByName: 'Siti Aminah',
    },
  });
  const replay = await request(app)
    .post('/api/v1/work/ORD-0098/close')
    .set('Cookie', cookie)
    .send(closure);

  expect(replay.status).toBe(409);
  expect(replay.body.error.code).toBe('E-WORK-NOT-OPEN');
  const { rows } = await pool.query(
    "SELECT count(*)::int AS count FROM decisions WHERE thread_id = (SELECT id FROM threads WHERE display_id = 'ORD-0098') AND kind = 'work'",
  );

  expect(rows[0].count).toBe(1);
});
test.each(['ORD-0100', 'ORD-0070'])(
  'Tentative or archived work %s cannot be closed',
  async (id) => {
    const response = await request(app)
      .post('/api/v1/work/' + id + '/close')
      .set('Cookie', cookie)
      .send(closure);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('E-WORK-NOT-OPEN');
  },
);
test('Outside-chat closure stores cancelled status; simultaneous closes make one decision', async () => {
  const responses = await Promise.all(
    [1, 2].map(() =>
      request(app)
        .post('/api/v1/work/ORD-0091/close')
        .set('Cookie', cookie)
        .send({ closure: 'outside_chat', reason: 'Handled outside this chat.' }),
    ),
  );

  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(responses.find((response) => response.status === 200)?.body.data).toMatchObject({
    status: 'cancelled',
    closure: { kind: 'outside_chat' },
  });
  const { rows } = await pool.query(
    "SELECT count(*)::int AS count FROM decisions WHERE thread_id = (SELECT id FROM threads WHERE display_id = 'ORD-0091') AND kind = 'work'",
  );

  expect(rows[0].count).toBe(1);
});
test.each([
  { ...closure, reason: ' '.repeat(10) },
  { ...closure, reason: 'a'.repeat(301) },
  { ...closure, status: 'cancelled' },
])('Closure rejects invalid or server-owned fields %j', async (body) => {
  const response = await request(app)
    .post('/api/v1/work/ORD-0098/close')
    .set('Cookie', cookie)
    .send(body);

  expect(response.status).toBe(422);
});
