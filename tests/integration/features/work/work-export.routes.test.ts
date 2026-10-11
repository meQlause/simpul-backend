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

test('GET /work/export returns six quoted columns with BOM and CRLF and all filtered rows', async () => {
  const response = await request(app).get('/api/v1/work/export').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
  expect(response.headers['content-disposition']).toBe(
    'attachment; filename="simpul-summary-2026-10-10.csv"',
  );
  expect(Buffer.from(response.text).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  const lines = response.text.slice(1).split('\r\n');

  expect(lines[0]).toBe('"ID","Customer","Work","Owner","Channel","Status"');
  expect(lines.at(-1)).toBe('');
  expect(response.text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/u);
  const {
    rows: [count],
  } = await pool.query('SELECT count(*)::int AS count FROM threads');

  expect(lines.length - 2).toBe(count.count);
  expect(lines.length).toBeGreaterThan(100);
});
test.each(['=', '+', '-', '@'])(
  'Export prefixes formula-starting %s cells and escapes quoted names',
  async (prefix) => {
    await pool.query("UPDATE threads SET customer_label = $1 WHERE display_id = 'ORD-0098'", [
      prefix + 'SUM("1")',
    ]);
    const response = await request(app)
      .get('/api/v1/work/export')
      .query({ q: 'ORD-0098' })
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.text).toContain('"' + "'" + prefix + 'SUM(""1"")"');
    expect(response.text.split('\r\n')).toHaveLength(3);
  },
);
test('Export applies the same derived stalled filter and search as the work list', async () => {
  const response = await request(app)
    .get('/api/v1/work/export')
    .query({ status: 'stalled', q: 'Mrs. Sri' })
    .set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.text).toContain('"ORD-0091","Mrs. Sri"');
  expect(response.text).toContain('"Stalled"\r\n');
  expect(response.text.split('\r\n')).toHaveLength(3);
});
test.each([{ status: 'invalid' }, { q: 'a'.repeat(101) }, { limit: 1 }, { cursor: 'abc' }])(
  'Unpaginated export rejects invalid query %j',
  async (query) => {
    const response = await request(app)
      .get('/api/v1/work/export')
      .query(query)
      .set('Cookie', cookie);

    expect(response.status).toBe(422);
    expect(response.headers['content-type']).toContain('application/json');
  },
);
