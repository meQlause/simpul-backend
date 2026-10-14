import { createSecretStore } from '../../src/platform/secrets/index.js';
import { beforeAll, expect, test } from 'vitest';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
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
  audit: { model: { generate: async () => '{"operations":[]}' } },
  database: {
    systemPool: pool,
    systemHost: 'system.example',
    masterKey: Buffer.alloc(32, 7).toString('base64'),
    now: () => new Date(),
  },
  connectionSetup: {
    masterKey: Buffer.alloc(32, 7).toString('base64'),
    publicBaseUrl: 'https://simpul.example',
    now: () => new Date('2026-10-10T04:01:00Z'),
    newId: randomUUID,
    newWebhookSecret: () => Buffer.alloc(32, 8).toString('base64url'),
    newCode: () => randomUUID().replaceAll('-', ''),
  },
  telegram: {
    checkReadiness: async () => [],
    describeChat: async () => ({ chatType: 'supergroup', title: 'Test group' }),
    send: async () => ({ providerMessageId: 'test-indicator' }),
    registerWebhook: async () => {},
    verifyCredential: async () => ({
      providerAccountId: 'test-bot',
      botUsername: 'test_bot',
      botName: 'Test bot',
      canJoinGroups: true,
      privacyModeOk: true,
    }),
  },
  mail: {
    masterKey: Buffer.alloc(32, 7).toString('base64'),
    verifyMail: async () => {},
    now: () => new Date('2026-10-10T04:01:00Z'),
  },
});
let adminCookie: string;
let memberCookie: string;
let personA: string;
let connectionA: string;
let sessionA: string;
let channelA: string;
let categoryA: string;
let reviewItemA: string;
let ruleA: string;
let decisionA: string;
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
  'get /database': {},
  'put /database': {
    connectionString: 'postgres://admin:private@customer.example/simpul?sslmode=require',
  },
  'get /decisions': {},
  'get /decisions/:decisionId': {},
  'get /messages': {},
  'post /messages/:unitId/correct': { action: 'attach', workDisplayId: 'ORD-0098' },
  'get /work': {},
  'get /work/export': {},
  'get /work/:displayId': {},
  'post /work/:displayId/close/undo': {},
  'post /work/:displayId/close': { closure: 'completed', reason: 'Delivered to the customer.' },
  'get /vocabulary': {},
  'post /categories': {
    name: 'Regression category',
    description: 'Verified tenant isolation',
    example: 'Confirmed order',
    idPrefix: 'REG',
  },
  'patch /categories/:categoryId': { description: 'Verified category update' },
  'put /templates/internal': { body: '{{work_id}} · {{customer}} · {{summary}}' },
  'post /aliases': { alias: 'Regression alias', personId: '00000000-0000-4000-8000-000000100099' },
  'post /channels/:channelId/verify': {},
  'patch /channels/:channelId': { displayName: 'Updated group', expectedConfigVersion: 99 },
  'post /channels/:channelId/pause': { expectedConfigVersion: 99 },
  'put /telegram/connections/:connectionId/credentials': {
    botToken: 'test-only-replacement-token',
    expectedCredentialVersion: 1,
  },
  'post /channels/:channelId/activate': {
    verificationId: '00000000-0000-4000-8000-000000100099',
    authorizationAck: true,
    expectedConfigVersion: 1,
  },
  'get /channels': {},
  'get /channels/:channelId': {},
  'post /telegram/connections/:connectionId/sessions': { purpose: 'identify_group' },
  'get /telegram/connection-sessions/:sessionId': {},
  'get /telegram/connections': {},
  'post /channels': {
    botConnectionId: '00000000-0000-4000-8000-000000100031',
    providerChatId: '-12345',
    displayName: 'Test draft',
  },
  'get /me': {},
  'get /overview': {},
  'get /rules': {},
  'post /rules': {},
  'post /rules/estimate': {},
  'patch /rules/:ruleId': { active: false },
  'post /onboarding/complete': { backups: [], activeRuleIds: [] },
  'get /previews/recipient': {},
  'get /review-items': {},
  'get /review-items/:itemId': {},
  'post /review-items/:itemId/resolve': { personId: '00000000-0000-4000-8000-000000100099' },
  'post /telegram/connections/verify': { botToken: 'test-only-credential' },
  'post /telegram/connections': { connectionName: 'My bot', botToken: 'test-only-credential' },
  'get /people': {},
  'get /settings': {},
  'get /settings/mail': {},
  'put /settings': settings,
  'put /settings/mail': mail,
  'patch /people/:personId': { availability: 'leave' },
};
const statuses: Record<string, number> = {
  'get /database': 404,
  'put /database': 404,
  'post /messages/:unitId/correct': 404,
  'post /work/:displayId/close/undo': 409,
  'post /categories': 201,
  'post /rules': 201,
  'post /onboarding/complete': 422,
  'post /aliases': 201,
  'patch /channels/:channelId': 409,
  'post /channels/:channelId/pause': 409,
  'put /telegram/connections/:connectionId/credentials': 422,
  'post /channels/:channelId/activate': 409,
  'post /telegram/connections/:connectionId/sessions': 201,
  'post /telegram/connections': 409,
  'post /channels': 201,
};

async function prepareReviewRoute() {
  decisionA = (
    await pool.query(
      'SELECT id FROM decisions WHERE workspace_id <> $1 ORDER BY occurred_at DESC LIMIT 1',
      [workspaceB],
    )
  ).rows[0].id;
  reviewItemA = (
    await pool.query(
      "SELECT id FROM review_items WHERE detected_text = 'Pak Bud' AND workspace_id <> $1",
      [workspaceB],
    )
  ).rows[0].id;
  bodies['post /review-items/:itemId/resolve'] = { personId: personA };
  const rule = (
    await pool.query(
      'SELECT id, domain_id, recipient_role_id FROM rules WHERE workspace_id <> $1 ORDER BY id LIMIT 1',
      [workspaceB],
    )
  ).rows[0];

  ruleA = rule.id;
  bodies['post /rules'] = {
    name: 'Tenant isolation rule',
    categoryId: rule.domain_id,
    eventType: 'progress',
    conditionText: 'Confirmed update',
    recipientRoleId: rule.recipient_role_id,
    historyMode: 'future',
  };
  bodies['post /rules/estimate'] = {
    categoryId: rule.domain_id,
    eventType: 'progress',
    recipientRoleId: rule.recipient_role_id,
  };
}

async function prepareRouteParameters() {
  categoryA = (
    await pool.query(
      "SELECT id FROM vocab_domains WHERE id_prefix = 'ORD' AND workspace_id <> $1",
      [workspaceB],
    )
  ).rows[0].id;
  await prepareReviewRoute();
  bodies['post /aliases'] = { alias: 'Regression alias', personId: personA };
  channelA = (
    await pool.query('SELECT id FROM channels WHERE workspace_id = $1 ORDER BY id LIMIT 1', [
      pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') }).workspaceId,
    ])
  ).rows[0].id;
  connectionA = (
    await pool.query("SELECT id FROM bot_connections WHERE provider_account_id = '240000000'")
  ).rows[0].id;
  const workspaceId = pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') }).workspaceId;
  const client = await pool.connect();

  try {
    const tokenRef = await createSecretStore(Buffer.alloc(32, 7).toString('base64')).put(
      client,
      workspaceId,
      { purpose: 'bot_token', value: 'test-only-admin-route-token' },
    );

    await client.query('UPDATE bot_connections SET token_secret_ref = $2 WHERE id = $1', [
      connectionA,
      tokenRef,
    ]);
  } finally {
    client.release();
  }

  bodies['post /channels'] = { ...bodies['post /channels'], botConnectionId: connectionA };
  const session = await supertest(app)
    .post(`/api/v1/telegram/connections/${connectionA}/sessions`)
    .set('Cookie', adminCookie)
    .send({ purpose: 'identify_group' });

  expect(session.status).toBe(201);
  sessionA = session.body.data.id;
}

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
  await pool.query('ANALYZE'); // the planner needs real row counts for the 8,400-unit seed
  await seedTenantRows(pool, workspaceB);
  tables = await scopedTableNames(pool);
  personA = (await pool.query<{ id: string }>("SELECT id FROM people WHERE name = 'Budi Santoso'"))
    .rows[0].id;
  adminCookie = await login('Siti Aminah', 'admin@pointstar.example');
  memberCookie = await login('Budi Santoso', 'member@pointstar.example');
  await prepareRouteParameters();
  await pool.query('CREATE ROLE test_app NOLOGIN NOSUPERUSER NOBYPASSRLS');
  await pool.query('GRANT USAGE ON SCHEMA public TO test_app');
  await pool.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO test_app',
  );
  await pool.query('GRANT EXECUTE ON FUNCTION workspace_for_session(text) TO test_app');
  await pool.query('SET ROLE test_app');
}, 120000);

function request(route: Route, personId = personA) {
  const path = `/api/v1${route.path.replace(':unitId', workspaceB).replace(':decisionId', decisionA).replace(':itemId', reviewItemA).replace(':ruleId', ruleA).replace(':displayId', 'ORD-0098').replace(':categoryId', categoryA).replace(':personId', personId).replace(':connectionId', connectionA).replace(':sessionId', sessionA).replace(':channelId', channelA)}`;
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

  if (route.method === 'post') {
    return agent.post(path);
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

  if (route.method === 'get' && route.path === '/me') {
    // The one identity endpoint: a member reads their own name, nothing else.
    expect(member.status).toBe(200);

    return;
  }

  expect(member.status).toBe(403);
  expect(member.body.error.code).toBe('E-FORBIDDEN');
});

test.each(routes)('REG-007: $method $path as A reads or changes no row of B', async (route) => {
  const before = await foreignSnapshot();
  const response = await request(route)
    .set('Cookie', adminCookie)
    .set('Idempotency-Key', 'admin-route-isolation')
    .set('X-Workspace-ID', workspaceB)
    .send(bodies[`${route.method} ${route.path}`]);

  expect(response.status).toBe(statuses[`${route.method} ${route.path}`] ?? 200);
  const payload = response.text ?? JSON.stringify(response.body);

  expect(payload).not.toContain(workspaceB);
  expect(payload).not.toContain('Test operator');
  expect(payload).not.toContain('test-only-password');
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
      code:
        route.path.startsWith('/telegram/') || route.path.startsWith('/channels')
          ? 'E-TG-INPUT-INVALID'
          : 'E-VALIDATION',
      details: [{ field: 'workspaceId', issue: 'unknown' }],
    });
    expect(await foreignSnapshot()).toEqual(before);
  },
);

test('REG-007: a foreign decision cannot be read through its id', async () => {
  const response = await supertest(app)
    .get(`/api/v1/decisions/${workspaceB}`)
    .set('Cookie', adminCookie);

  expect(response.status).toBe(404);
  expect(response.body.error.code).toBe('E-NOT-FOUND');
});

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

test('REG-007: a foreign connection and session cannot identify or create a group', async () => {
  const before = await foreignSnapshot();
  const issue = await supertest(app)
    .post(`/api/v1/telegram/connections/${workspaceB}/sessions`)
    .set('Cookie', adminCookie)
    .send({ purpose: 'identify_group' });

  expect(issue.status).toBe(404);
  const poll = await supertest(app)
    .get(`/api/v1/telegram/connection-sessions/${workspaceB}`)
    .set('Cookie', adminCookie);

  expect(poll.status).toBe(404);
  const create = await supertest(app).post('/api/v1/channels').set('Cookie', adminCookie).send({
    botConnectionId: connectionA,
    sessionId: workspaceB,
    displayName: 'Foreign candidate',
  });

  expect(create.status).toBe(410);
  expect(create.body.error.code).toBe('E-TG-SESSION-EXPIRED');
  expect(await foreignSnapshot()).toEqual(before);
});
