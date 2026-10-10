import { beforeAll, expect, test } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../../src/app.js';
import { createAuthentication, provisionAdmin } from '../../src/features/auth/index.js';
import { createConnectionResolver } from '../../src/platform/db/connection-resolver.js';
import { databaseFixture } from '../helpers/database.js';
import { applyMigrations, scopedTableNames } from '../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../fixtures/point-star.js';
import { seedTenantRows } from '../fixtures/tenant-rows.js';

const pool = databaseFixture();
const workspaceB = '00000000-0000-4000-8000-000000100002';
const auth = createAuthentication(pool, {
  baseUrl: 'https://simpul.example',
  secret: 'test-only-auth-secret-with-more-than-32-characters',
});
const app = createApp('api', undefined, undefined, {
  authentication: auth,
  resolveConnection: createConnectionResolver(pool),
  mail: {
    masterKey: Buffer.alloc(32, 7).toString('base64'),
    verifyMail: async () => {},
    now: () => new Date('2026-10-10T04:01:00Z'),
  },
});
let adminCookie: string;
let memberCookie: string;
let personA: string;
let tables: string[];

type Layer = {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
};
type Route = { method: string; path: string };

function mountedRoutes(stack: Layer[]): Route[] {
  return stack.flatMap((layer) => {
    if (layer.route) {
      const route = layer.route;
      return Object.keys(route.methods).map((method) => ({ method, path: route.path }));
    }
    return mountedRoutes(layer.handle?.stack ?? []);
  });
}

const routes = mountedRoutes(app.router.stack as Layer[]).filter(
  (route) => !route.path.startsWith('/api/auth/'),
);
const settings = {
  quietStart: '22:00',
  quietEnd: '06:00',
  budgetPerHour: 8,
  digestTime: '09:00',
};
const mail = {
  host: 'smtp.example.com',
  port: 587,
  username: 'admin',
  password: 'test-only-password',
  fromAddress: 'admin@example.com',
};
const bodies: Record<string, object> = {
  'get /me': {},
  'get /people': {},
  'get /settings/mail': {},
  'put /settings': settings,
  'put /settings/mail': mail,
  'patch /people/:personId': { availability: 'leave' },
};

async function login(name: string, email: string) {
  const client = await pool.connect();
  try {
    await provisionAdmin(client, {
      id: email,
      name,
      email,
      token: email,
      now: new Date(),
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
    await client.query('UPDATE people SET auth_user_id = $1 WHERE name = $2', [email, name]);
  } finally {
    client.release();
  }
  await auth.api.resetPassword({ body: { token: email, newPassword: 'test-password-123' } });
  const response = await auth.api.signInEmail({
    body: { email, password: 'test-password-123' },
    asResponse: true,
  });
  return response.headers.get('set-cookie') ?? '';
}

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') }));
  await seedTenantRows(pool, workspaceB);
  tables = await scopedTableNames(pool);
  personA = (await pool.query<{ id: string }>("SELECT id FROM people WHERE name = 'Budi Santoso'"))
    .rows[0].id;
  adminCookie = await login('Siti Aminah', 'admin@pointstar.example');
  memberCookie = await login('Budi Santoso', 'member@pointstar.example');
  await pool.query('CREATE ROLE test_app NOLOGIN NOSUPERUSER NOBYPASSRLS');
  await pool.query('GRANT USAGE ON SCHEMA public TO test_app');
  await pool.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO test_app',
  );
  await pool.query('GRANT EXECUTE ON FUNCTION workspace_for_session(text) TO test_app');
  await pool.query('SET ROLE test_app');
}, 120000);

function request(route: Route, personId = personA) {
  const path = `/api/v1${route.path.replace(':personId', personId)}`;
  const agent = supertest(app);
  if (route.method === 'get') {
    return agent.get(path);
  }
  if (route.method === 'put') {
    return agent.put(path);
  }
  if (route.method === 'patch') {
    return agent.patch(path);
  }
  throw new Error(`Add a valid request for ${route.method} ${route.path}`);
}

async function foreignSnapshot() {
  const client = await pool.connect();
  try {
    await client.query('RESET ROLE');
    const rows: Record<string, unknown> = {};
    for (const table of tables) {
      rows[table] = (
        await client.query(
          `SELECT to_jsonb(record) AS snapshot FROM "${table}" AS record WHERE workspace_id = $1 ORDER BY to_jsonb(record)::text`,
          [workspaceB],
        )
      ).rows;
    }
    rows.workspaces = (
      await client.query('SELECT * FROM workspaces WHERE id = $1', [workspaceB])
    ).rows;
    return rows;
  } finally {
    await client.query('SET ROLE test_app');
    client.release();
  }
}

test('REG-007 iterates every mounted admin route and passes', () => {
  expect(routes.length).toBeGreaterThan(0);
  expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual(
    Object.keys(bodies).sort(),
  );
});

test.each(routes)('REG-007: $method $path requires an admin session', async (route) => {
  const body = bodies[`${route.method} ${route.path}`];
  const anonymous = await request(route).send(body);
  expect(anonymous.status).toBe(401);
  expect(anonymous.body.error.code).toBe('E-AUTH-REQUIRED');
  const member = await request(route).set('Cookie', memberCookie).send(body);
  expect(member.status).toBe(403);
  expect(member.body.error.code).toBe('E-FORBIDDEN');
});

test.each(routes)('REG-007: $method $path as A reads or changes no row of B', async (route) => {
  const before = await foreignSnapshot();
  const response = await request(route)
    .set('Cookie', adminCookie)
    .set('X-Workspace-ID', workspaceB)
    .send(bodies[`${route.method} ${route.path}`]);
  expect(response.status).toBe(200);
  expect(JSON.stringify(response.body)).not.toContain(workspaceB);
  expect(JSON.stringify(response.body)).not.toContain('Test operator');
  expect(JSON.stringify(response.body)).not.toContain('test-only-password');
  expect(await foreignSnapshot()).toEqual(before);
});

test.each(routes.filter((route) => route.method !== 'get'))(
  'REG-007: $method $path rejects a client-selected workspace',
  async (route) => {
    const before = await foreignSnapshot();
    const response = await request(route)
      .set('Cookie', adminCookie)
      .send({ ...bodies[`${route.method} ${route.path}`], workspaceId: workspaceB });
    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: 'E-VALIDATION',
      details: [{ field: 'workspaceId', issue: 'unknown' }],
    });
    expect(await foreignSnapshot()).toEqual(before);
  },
);

test('REG-007: a foreign person and foreign backup cannot be changed or assigned', async () => {
  const before = await foreignSnapshot();
  const route = { method: 'patch', path: '/people/:personId' };
  const foreign = await request(route, workspaceB)
    .set('Cookie', adminCookie)
    .send({ availability: 'leave' });
  expect(foreign.status).toBe(404);
  const backup = await request(route)
    .set('Cookie', adminCookie)
    .send({ backupPersonId: workspaceB });
  expect(backup.status).toBe(422);
  expect(backup.body.error.code).toBe('E-VALIDATION');
  expect(await foreignSnapshot()).toEqual(before);
});
