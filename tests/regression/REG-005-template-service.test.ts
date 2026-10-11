import { beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import { databaseFixture, createConnectionResolver } from '../helpers/database-mode.js';
import { applyMigrations } from '../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../fixtures/point-star.js';
import { signInSeedAdmin } from '../helpers/admin-session.js';
import { createApp } from '../../src/app.js';

const pool = databaseFixture();
const now = new Date('2026-10-10T04:01:00Z');
let app: ReturnType<typeof createApp>;
let cookie: string;

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => now }));
  const session = await signInSeedAdmin(pool, {
    id: 'template-admin',
    email: 'template@pointstar.example',
  });

  cookie = session.cookie;
  app = createApp('api', undefined, undefined, {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
    work: { now: () => now },
  });
});

test.each(['cost', 'margin', 'internal_note', 'unknown'])(
  'PUT /templates/internal with {{%s}} returns 422 E-TEMPLATE-FIELD-NOT-ALLOWED (REG-005, service level)',
  async (field) => {
    const before = (await pool.query('SELECT audience, body FROM templates ORDER BY audience'))
      .rows;
    const audits = (await pool.query('SELECT id FROM config_audit')).rows;
    const response = await request(app)
      .put('/api/v1/templates/internal')
      .set('Cookie', cookie)
      .send({ body: '{{' + field + '}}' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('E-TEMPLATE-FIELD-NOT-ALLOWED');
    expect(response.body.error.details).toEqual([{ field: 'body', issue: 'invalid' }]);
    expect(
      (await pool.query('SELECT audience, body FROM templates ORDER BY audience')).rows,
    ).toEqual(before);
    expect((await pool.query('SELECT id FROM config_audit')).rows).toEqual(audits);
  },
);

test('Internal template saves approved fields, leaves the external template fixed, and records its audit', async () => {
  const external = (await pool.query("SELECT body FROM templates WHERE audience = 'external'"))
    .rows;
  const version = (await pool.query('SELECT vocab_version FROM workspaces')).rows[0].vocab_version;
  const body = '{{work_id}} for {{customer}}: {{summary}}';
  const response = await request(app)
    .put('/api/v1/templates/internal')
    .set('Cookie', cookie)
    .send({ body });

  expect(response.status).toBe(200);
  expect(response.body.data).toEqual({ body, allowedFields: ['work_id', 'customer', 'summary'] });
  expect((await pool.query("SELECT body FROM templates WHERE audience = 'external'")).rows).toEqual(
    external,
  );
  expect((await pool.query('SELECT vocab_version FROM workspaces')).rows[0].vocab_version).toBe(
    version,
  );
  expect(
    (await pool.query("SELECT table_name FROM config_audit WHERE table_name = 'templates'")).rows,
  ).toEqual([{ table_name: 'templates' }]);
});

test.each([
  { body: '' },
  { body: 'x'.repeat(301) },
  { body: '{{cost' },
  { body: 'allowed', editable: false },
])('Internal template rejects invalid input %j', async (input) => {
  const response = await request(app)
    .put('/api/v1/templates/internal')
    .set('Cookie', cookie)
    .send(input);

  expect(response.status).toBe(422);
});
