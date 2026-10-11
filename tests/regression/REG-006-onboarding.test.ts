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
let backups: { roleId: string; personId: string }[];

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, seed);
  const session = await signInSeedAdmin(pool, {
    id: 'onboarding-admin',
    email: 'onboarding@pointstar.example',
  });

  cookie = session.cookie;
  app = createApp('api', undefined, undefined, {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
    overview: { now: () => instant },
  });
  backups = (
    await pool.query(
      `SELECT role.id AS "roleId", (SELECT person.id FROM people person WHERE person.workspace_id = $1 AND person.active
    AND NOT EXISTS (SELECT 1 FROM role_members member WHERE member.workspace_id = $1 AND member.role_id = role.id AND member.person_id = person.id AND member.kind = 'member') ORDER BY person.id LIMIT 1) AS "personId"
    FROM roles role WHERE role.workspace_id = $1 AND role.active ORDER BY role.id`,
      [seed.workspaceId],
    )
  ).rows;
}, 120000);

test('REG-006 / FR-UI-01: missing backups are rejected without changing configuration', async () => {
  const response = await request(app)
    .post('/api/v1/onboarding/complete')
    .set('Cookie', cookie)
    .send({ backups: [], activeRuleIds: [] });

  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe('E-ONBOARDING-BACKUP-MISSING');
  expect(
    (
      await pool.query('SELECT onboarding_completed_at FROM workspaces WHERE id = $1', [
        seed.workspaceId,
      ])
    ).rows[0].onboarding_completed_at,
  ).toBeNull();
  expect(
    (
      await pool.query(
        'SELECT count(*)::int AS total FROM rules WHERE workspace_id = $1 AND active',
        [seed.workspaceId],
      )
    ).rows[0].total,
  ).toBe(3);
});

test('REG-006 / FR-UI-01: no active group is rejected and no draft becomes active', async () => {
  await pool.query(
    "UPDATE channels SET monitored = false, connection_status = 'draft' WHERE workspace_id = $1",
    [seed.workspaceId],
  );
  const response = await request(app)
    .post('/api/v1/onboarding/complete')
    .set('Cookie', cookie)
    .send({ backups, activeRuleIds: [] });

  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe('E-ONBOARDING-NO-ACTIVE-GROUP');
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS total FROM channels WHERE workspace_id = $1 AND connection_status = 'draft'",
        [seed.workspaceId],
      )
    ).rows[0].total,
  ).toBe(3);
});

test('REG-006 / FR-UI-01: completion writes backups and rule states but sends nothing and activates no draft', async () => {
  await pool.query(
    "UPDATE channels SET monitored = true, connection_status = 'active', verified_config_version = config_version WHERE id = md5('point-star-channel-1')::uuid",
  );
  await pool.query(
    `INSERT INTO channel_verifications (workspace_id, channel_id, bot_connection_id, config_version, credential_version, checks, status, checked_at, expires_at)
    SELECT $1, c.id, b.id, c.config_version, b.credential_version, '[]', 'pass', $2::timestamptz, $2::timestamptz + interval '10 minutes'
    FROM channels c JOIN bot_connections b ON b.id = c.bot_connection_id WHERE c.workspace_id = $1 AND c.id = md5('point-star-channel-1')::uuid`,
    [seed.workspaceId, instant],
  );
  const before = (await pool.query('SELECT count(*)::int AS total FROM notifications')).rows[0]
    .total;
  const response = await request(app)
    .post('/api/v1/onboarding/complete')
    .set('Cookie', cookie)
    .send({ backups, activeRuleIds: [] });

  expect(response.status).toBe(200);
  expect(response.body.data.onboardingCompletedAt).toBe(instant.toISOString());
  expect((await pool.query('SELECT count(*)::int AS total FROM notifications')).rows[0].total).toBe(
    before,
  );
  expect(
    (
      await pool.query(
        'SELECT count(*)::int AS total FROM rules WHERE workspace_id = $1 AND active',
        [seed.workspaceId],
      )
    ).rows[0].total,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS total FROM channels WHERE workspace_id = $1 AND connection_status = 'draft'",
        [seed.workspaceId],
      )
    ).rows[0].total,
  ).toBe(2);
});

test('REG-006 / Workspace §5: an unknown rule rolls back backup changes and completion', async () => {
  const before = (
    await pool.query(
      "SELECT role_id, person_id, created_at FROM role_members WHERE workspace_id = $1 AND kind = 'backup' ORDER BY role_id, person_id",
      [seed.workspaceId],
    )
  ).rows;
  const response = await request(app)
    .post('/api/v1/onboarding/complete')
    .set('Cookie', cookie)
    .send({ backups, activeRuleIds: [randomUUID()] });

  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe('E-VALIDATION');
  expect(
    (
      await pool.query(
        "SELECT role_id, person_id, created_at FROM role_members WHERE workspace_id = $1 AND kind = 'backup' ORDER BY role_id, person_id",
        [seed.workspaceId],
      )
    ).rows,
  ).toEqual(before);
});

test('REG-006 / Workspace §5: a role member cannot be their own backup', async () => {
  const member = (
    await pool.query(
      "SELECT person_id FROM role_members WHERE role_id = $1 AND kind = 'member' LIMIT 1",
      [backups[0].roleId],
    )
  ).rows[0].person_id as string;
  const response = await request(app)
    .post('/api/v1/onboarding/complete')
    .set('Cookie', cookie)
    .send({
      backups: [{ ...backups[0], personId: member }, ...backups.slice(1)],
      activeRuleIds: [],
    });

  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe('E-ONBOARDING-BACKUP-MISSING');
});

test('Workspace §5: onboarding requires an admin session and rejects duplicate role entries', async () => {
  expect(
    (await request(app).post('/api/v1/onboarding/complete').send({ backups, activeRuleIds: [] }))
      .status,
  ).toBe(401);
  const response = await request(app)
    .post('/api/v1/onboarding/complete')
    .set('Cookie', cookie)
    .send({ backups: [...backups, backups[0]], activeRuleIds: [] });

  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe('E-VALIDATION');
});
