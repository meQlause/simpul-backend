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
    id: 'vocabulary-admin',
    email: 'vocabulary@pointstar.example',
  });

  cookie = session.cookie;
  app = createApp('api', undefined, undefined, {
    authentication: session.authentication,
    resolveConnection: createConnectionResolver(pool),
    work: { now: () => now },
  });
});

const category = {
  name: 'Procurement',
  description: 'Supplier purchase requests',
  example: 'Please order two cases from the supplier.',
  idPrefix: 'PRC',
};

test('Creating a category increments vocabVersion; an alias does not', async () => {
  const before = (await pool.query('SELECT vocab_version FROM workspaces')).rows[0].vocab_version;
  const created = await request(app)
    .post('/api/v1/categories')
    .set('Cookie', cookie)
    .send(category);

  expect(created.status).toBe(201);
  expect(created.body.data).toMatchObject({
    category: { ...category, prefixInUse: false },
    version: before + 1,
  });
  expect(
    (
      await pool.query('SELECT last_value FROM display_id_counters WHERE domain_id = $1', [
        created.body.data.category.id,
      ])
    ).rows,
  ).toEqual([{ last_value: 0 }]);
  const person = (await pool.query("SELECT id FROM people WHERE name = 'Rina Anggraini'")).rows[0];
  const alias = await request(app)
    .post('/api/v1/aliases')
    .set('Cookie', cookie)
    .send({ alias: 'Bu Rin', personId: person.id });

  expect(alias.status).toBe(201);
  expect(alias.body.data).toMatchObject({
    alias: 'Bu Rin',
    person: { id: person.id, name: 'Rina Anggraini' },
  });
  const vocabulary = await request(app).get('/api/v1/vocabulary').set('Cookie', cookie);

  expect(vocabulary.status).toBe(200);
  expect(vocabulary.body.data.version).toBe(before + 1);
  expect(vocabulary.body.data.categories).toContainEqual(
    expect.objectContaining({ id: created.body.data.category.id, name: category.name }),
  );
  expect(vocabulary.body.data.aliases).toContainEqual(alias.body.data);
  expect(
    (
      await pool.query(
        "SELECT table_name FROM config_audit WHERE table_name IN ('vocab_domains', 'aliases') ORDER BY created_at",
      )
    ).rows,
  ).toEqual([{ table_name: 'vocab_domains' }, { table_name: 'aliases' }]);
});

test('Duplicate category names or prefixes roll back the version increment and counter creation', async () => {
  const before = (await pool.query('SELECT vocab_version FROM workspaces')).rows[0].vocab_version;

  for (const input of [
    { ...category, name: 'procurement', idPrefix: 'XYZ' },
    { ...category, name: 'Different category' },
  ]) {
    const response = await request(app)
      .post('/api/v1/categories')
      .set('Cookie', cookie)
      .send(input);

    expect(response.status).toBe(422);
    expect(response.body.error.details).toContainEqual(
      expect.objectContaining({ issue: 'duplicate' }),
    );
  }

  expect((await pool.query('SELECT vocab_version FROM workspaces')).rows[0].vocab_version).toBe(
    before,
  );
  expect(
    (await pool.query("SELECT id FROM vocab_domains WHERE id_prefix = 'XYZ'")).rows,
  ).toHaveLength(0);
});

test('An alias requires an active person and rejects duplicates without changing vocabVersion', async () => {
  const before = (await pool.query('SELECT vocab_version FROM workspaces')).rows[0].vocab_version;
  const person = (await pool.query("SELECT id FROM people WHERE name = 'Rina Anggraini'")).rows[0];
  const duplicate = await request(app)
    .post('/api/v1/aliases')
    .set('Cookie', cookie)
    .send({ alias: 'bu rin', personId: person.id });
  const missing = await request(app)
    .post('/api/v1/aliases')
    .set('Cookie', cookie)
    .send({ alias: 'Unknown', personId: '00000000-0000-4000-8000-000000999999' });

  expect(duplicate.status).toBe(422);
  expect(missing.status).toBe(422);
  expect((await pool.query('SELECT vocab_version FROM workspaces')).rows[0].vocab_version).toBe(
    before,
  );
});
