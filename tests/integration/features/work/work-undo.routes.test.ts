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

const notificationQuery =
  'SELECT id, thread_id, sent_at, cancelled_at FROM notifications ORDER BY id';
const closure = { closure: 'cancelled', reason: 'Customer cancelled the order.' };

async function prepareNotifications() {
  await pool.query(
    "UPDATE notifications SET thread_id = (SELECT id FROM threads WHERE display_id = 'ORD-0098') WHERE kind = 'update'",
  );
  await pool.query(
    "INSERT INTO notifications (workspace_id, label_id, thread_id, recipient_person_id, kind, channel, body_rendered, held_until) SELECT workspace_id, label_id, (SELECT id FROM threads WHERE display_id = 'ORD-0098'), recipient_person_id, 'escalation', channel, body_rendered, held_until FROM notifications WHERE kind = 'reminder'",
  );
}

test('Closing cancels pending and held notifications only for this item; undo restores active without resending', async () => {
  await prepareNotifications();
  const before = await pool.query(notificationQuery);
  const closed = await request(app)
    .post('/api/v1/work/ORD-0098/close')
    .set('Cookie', cookie)
    .send(closure);

  expect(closed.status).toBe(200);
  const {
    rows: [item],
  } = await pool.query("SELECT id FROM threads WHERE display_id = 'ORD-0098'");
  const after = await pool.query(notificationQuery);

  expect(
    before.rows.some(
      (notification) =>
        notification.thread_id === item.id && !notification.sent_at && !notification.cancelled_at,
    ),
  ).toBe(true);

  for (const [index, notification] of after.rows.entries()) {
    const previous = before.rows[index];

    expect(notification).toEqual(
      notification.thread_id === item.id && !previous.sent_at && !previous.cancelled_at
        ? { ...previous, cancelled_at: now }
        : previous,
    );
  }

  const undone = await request(app).post('/api/v1/work/ORD-0098/close/undo').set('Cookie', cookie);

  expect(undone.status).toBe(200);
  expect(undone.body.data).toMatchObject({
    status: 'active',
    closure: null,
    canClose: true,
    canUndoClose: false,
  });
  expect((await pool.query(notificationQuery)).rows).toEqual(after.rows);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM decisions WHERE thread_id = $1 AND kind = 'work'",
        [item.id],
      )
    ).rows[0].count,
  ).toBe(2);
});
test('Undo after later activity returns E-WORK-UNDO-UNAVAILABLE and preserves the closure', async () => {
  await request(app).post('/api/v1/work/ORD-0098/close').set('Cookie', cookie).send(closure);
  await pool.query(
    "UPDATE threads SET last_activity_at = $1::timestamptz + interval '1 second' WHERE display_id = 'ORD-0098'",
    [now],
  );
  const response = await request(app)
    .post('/api/v1/work/ORD-0098/close/undo')
    .set('Cookie', cookie);

  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('E-WORK-UNDO-UNAVAILABLE');
  const detail = await request(app).get('/api/v1/work/ORD-0098').set('Cookie', cookie);

  expect(detail.body.data).toMatchObject({ status: 'cancelled', canUndoClose: false });
});
test.each(['ORD-0095', 'ORD-0070', 'PAY-0034'])(
  'Evidence closure, archived or open item %s cannot be undone',
  async (id) => {
    const response = await request(app)
      .post('/api/v1/work/' + id + '/close/undo')
      .set('Cookie', cookie);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('E-WORK-UNDO-UNAVAILABLE');
  },
);
test('Undo restores derived stalled status and remains available after the toast expires', async () => {
  await request(app).post('/api/v1/work/ORD-0091/close').set('Cookie', cookie).send(closure);
  await pool.query(
    "UPDATE threads SET closed_at = $1::timestamptz - interval '1 hour' WHERE display_id = 'ORD-0091'",
    [now],
  );
  const response = await request(app)
    .post('/api/v1/work/ORD-0091/close/undo')
    .set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({ status: 'stalled', closure: null, canClose: true });
});
