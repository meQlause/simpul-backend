import { beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { signInSeedAdmin } from '../../../helpers/admin-session.js';
import { createApp } from '../../../../src/app.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';

const pool = databaseFixture();
const instant = new Date('2026-10-10T04:01:00Z');
const seed = pointStarSeed({ now: () => instant });
let app: ReturnType<typeof createApp>;
let cookie: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
  const session = await signInSeedAdmin(pool, {
    id: 'preview-admin',
    email: 'preview@pointstar.example',
  });

  cookie = session.cookie;
  app = createApp('api', undefined, undefined, {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
    overview: { now: () => instant },
  });
}, 120000);

test('Delivery §1 / FR-UI-05: Budi on leave previews Siti Aminah · Backup for Budi without changing work or sending', async () => {
  await pool.query(
    "UPDATE people SET availability = 'leave' WHERE workspace_id = $1 AND name = 'Budi Santoso'",
    [seed.workspaceId],
  );
  const before = (
    await pool.query(
      'SELECT id, status, last_activity_at FROM threads WHERE workspace_id = $1 ORDER BY id',
      [seed.workspaceId],
    )
  ).rows;
  const sent = (await pool.query('SELECT count(*)::int AS total FROM notifications')).rows[0].total;
  const response = await request(app).get('/api/v1/previews/recipient').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data.notification.recipientLabel).toBe('Siti Aminah · Backup for Budi');
  expect(response.body.data.notification.work.displayId).toBe('ORD-0091');
  expect(response.body.data.notification.actions).toEqual(['completed', 'active', 'stalled']);
  expect(
    (
      await pool.query(
        'SELECT id, status, last_activity_at FROM threads WHERE workspace_id = $1 ORDER BY id',
        [seed.workspaceId],
      )
    ).rows,
  ).toEqual(before);
  expect((await pool.query('SELECT count(*)::int AS total FROM notifications')).rows[0].total).toBe(
    sent,
  );
});

test('Delivery §1: the preview requires an admin session', async () => {
  expect((await request(app).get('/api/v1/previews/recipient')).status).toBe(401);
});

test('Delivery §1: unassigned open work still previews the workspace-admin fallback', async () => {
  await pool.query('UPDATE threads SET owner_person_id = NULL WHERE workspace_id = $1', [
    seed.workspaceId,
  ]);
  const response = await request(app).get('/api/v1/previews/recipient').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data.notification.recipientLabel).toBe(
    'Siti Aminah · Workspace admin fallback',
  );
});

test('Delivery §1: no available recipient previews the origin-group fallback', async () => {
  await pool.query("UPDATE people SET availability = 'leave' WHERE workspace_id = $1", [
    seed.workspaceId,
  ]);
  const response = await request(app).get('/api/v1/previews/recipient').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data.notification.recipientLabel).toBe(
    'Warehouse & Shipping group · No available recipient',
  );
});

test('Delivery §1: no open work returns empty notification and clarification previews', async () => {
  await pool.query(
    "UPDATE threads SET status = 'completed', closure_kind = 'completed', closed_at = $2 WHERE workspace_id = $1 AND status = 'active'",
    [seed.workspaceId, instant],
  );
  const response = await request(app).get('/api/v1/previews/recipient').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data.notification).toBeNull();
  expect(response.body.data.clarification).toBeNull();
});
