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
const now = new Date('2026-10-10T04:01:00Z');
let app: ReturnType<typeof createApp>;
let cookie: string;
let input: { categoryId: string; eventType: string; recipientRoleId: string };

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => now }));
  const session = await signInSeedAdmin(pool, {
    id: 'estimate-admin',
    email: 'estimate@pointstar.example',
  });

  cookie = session.cookie;
  app = createApp('api', undefined, undefined, {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
    rules: { now: () => now },
  });
  input = (
    await pool.query(
      'SELECT domain_id AS "categoryId", event_type AS "eventType", recipient_role_id AS "recipientRoleId" FROM rules ORDER BY created_at, id LIMIT 1',
    )
  ).rows[0];
}, 120000);

test('Rules §4: the seed estimate returns 64 matches, a peak of 5 and budget 6, writes nothing and sends nothing', async () => {
  const before = await pool.query(
    'SELECT (SELECT count(*) FROM notifications) AS notifications, (SELECT count(*) FROM rules) AS rules, (SELECT count(*) FROM config_audit) AS audit, (SELECT count(*) FROM digests) AS digests',
  );
  const response = await request(app)
    .post('/api/v1/rules/estimate')
    .set('Cookie', cookie)
    .send(input);

  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    data: {
      matches30d: 64,
      peakPerHour: 5,
      budgetPerHour: 6,
      exceedsBudget: false,
      recipient: { holderName: 'Budi Santoso' },
    },
  });
  const after = await pool.query(
    'SELECT (SELECT count(*) FROM notifications) AS notifications, (SELECT count(*) FROM rules) AS rules, (SELECT count(*) FROM config_audit) AS audit, (SELECT count(*) FROM digests) AS digests',
  );

  expect(after.rows).toEqual(before.rows);
});

test('Rules §4: requests require authentication and reject missing, malformed and unknown workspace references', async () => {
  expect((await request(app).post('/api/v1/rules/estimate').send(input)).status).toBe(401);

  for (const body of [
    {},
    { ...input, eventType: 'invalid' },
    { ...input, categoryId: randomUUID() },
    { ...input, recipientRoleId: randomUUID() },
    { ...input, conditionText: 'invented' },
  ]) {
    const response = await request(app)
      .post('/api/v1/rules/estimate')
      .set('Cookie', cookie)
      .send(body);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('E-VALIDATION');
  }
});

test('Rules §4: peak equal to budget is allowed; a lower budget exceeds it', async () => {
  await pool.query('UPDATE policies SET budget_per_hour = 5');
  expect(
    (await request(app).post('/api/v1/rules/estimate').set('Cookie', cookie).send(input)).body.data
      .exceedsBudget,
  ).toBe(false);
  await pool.query('UPDATE policies SET budget_per_hour = 4');
  expect(
    (await request(app).post('/api/v1/rules/estimate').set('Cookie', cookie).send(input)).body.data
      .exceedsBudget,
  ).toBe(true);
});

test('Rules §4: the estimate excludes future, older and retracted labels and includes the 30-day boundary', async () => {
  await pool.query(
    `UPDATE labels SET created_at = $1::timestamptz + interval '1 second' WHERE id = md5('point-star-order-label-1')::uuid`,
    [now],
  );
  await pool.query(
    `UPDATE labels SET created_at = $1::timestamptz - interval '30 days 1 millisecond' WHERE id = md5('point-star-order-label-2')::uuid`,
    [now],
  );
  await pool.query(
    `UPDATE labels SET retracted_at = $1 WHERE id = md5('point-star-order-label-3')::uuid`,
    [now],
  );
  await pool.query(
    `UPDATE labels SET created_at = $1::timestamptz - interval '30 days' WHERE id = md5('point-star-order-label-4')::uuid`,
    [now],
  );
  const response = await request(app)
    .post('/api/v1/rules/estimate')
    .set('Cookie', cookie)
    .send(input);

  expect(response.status).toBe(200);
  expect(response.body.data.matches30d).toBe(61);
});

test('Rules §4: an empty category and event sample returns zero matches and zero peak', async () => {
  const response = await request(app)
    .post('/api/v1/rules/estimate')
    .set('Cookie', cookie)
    .send({ ...input, eventType: 'blocker' });

  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({ matches30d: 0, peakPerHour: 0, exceedsBudget: false });
});
