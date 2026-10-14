import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { Client } from 'pg';
import supertest from 'supertest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../../../fixtures/point-star.js';
import { createApp } from '../../../../src/app.js';
import { createAuthentication, provisionAdmin } from '../../../../src/features/auth/index.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';

const pool = databaseFixture();
let app: ReturnType<typeof createApp>;
let cookie: string;
const verifyMail =
  vi.fn<
    (credentials: {
      host: string;
      port: number;
      username: string;
      password: string;
    }) => Promise<void>
  >();
const mailPassword = 'test-only-mail-password';
const mailInput = {
  host: 'smtp.pointstar.example',
  port: 587,
  username: 'simpul@pointstar.example',
  password: mailPassword,
  fromAddress: 'simpul@pointstar.example',
};

afterEach(() => vi.restoreAllMocks());

beforeAll(async () => {
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') }));
  const client = await pool.connect();

  try {
    await provisionAdmin(client, {
      id: 'seed-admin',
      name: 'Siti Aminah',
      email: 'siti@pointstar.example',
      token: 'seed-admin-password-token',
      now: new Date(),
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
    await client.query("UPDATE people SET auth_user_id = 'seed-admin' WHERE name = 'Siti Aminah'");
  } finally {
    client.release();
  }

  const auth = createAuthentication(pool, {
    baseUrl: 'https://simpul.example',
    secret: 'test-only-auth-secret-with-more-than-32-characters',
  });

  await auth.api.resetPassword({
    body: { token: 'seed-admin-password-token', newPassword: 'test-password-123' },
  });
  const login = await auth.api.signInEmail({
    body: { email: 'siti@pointstar.example', password: 'test-password-123' },
    asResponse: true,
  });

  cookie = login.headers.get('set-cookie') ?? '';
  app = createApp('api', undefined, undefined, {
    authentication: auth,
    resolveConnection: createConnectionResolver(pool),
    mail: {
      masterKey: Buffer.alloc(32, 1).toString('base64'),
      verifyMail,
      now: () => new Date('2026-10-10T04:01:00Z'),
    },
  });
}, 120000);

test('GET /me for the seed returns counts members: 4, channels: 3, activeRules: 3', async () => {
  const response = await supertest(app).get('/api/v1/me').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data).toEqual({
    person: { id: expect.any(String), name: 'Siti Aminah', roleName: 'Operations Manager' },
    workspace: {
      id: '00000000-0000-4000-8000-000000100001',
      name: 'Point Star',
      descriptor: 'Operations workspace',
      timezone: 'Asia/Jakarta',
      onboardingCompletedAt: null,
      counts: { members: 4, channels: 3, activeRules: 3 },
    },
  });
});

test('GET /settings returns the workspace delivery preferences without internal ids', async () => {
  const response = await supertest(app).get('/api/v1/settings').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data).toEqual({
    quietStart: '21:00',
    quietEnd: '07:00',
    budgetPerHour: 6,
    digestTime: '08:30',
    holdSeconds: 60,
    timezone: 'Asia/Jakarta',
    contextWindowMinutes: 30,
    contextMaxMessages: 10,
    messageTextAccess: false,
  });
});

test('PUT /settings with quietStart equal to quietEnd returns 422 E-SETTINGS-QUIET-HOURS-EQUAL', async () => {
  const response = await supertest(app)
    .put('/api/v1/settings')
    .set('Cookie', cookie)
    .send({ quietStart: '21:00', quietEnd: '21:00', budgetPerHour: 6, digestTime: '08:30' });

  expect(response.status).toBe(422);
  expect(response.body.error).toMatchObject({
    code: 'E-SETTINGS-QUIET-HOURS-EQUAL',
    message: 'Choose different start and end times.',
    details: [{ field: 'quietEnd', issue: 'invalid' }],
  });
});

test('PUT /settings with budgetPerHour: 0 returns 422 E-VALIDATION', async () => {
  const response = await supertest(app)
    .put('/api/v1/settings')
    .set('Cookie', cookie)
    .send({ quietStart: '21:00', quietEnd: '07:00', budgetPerHour: 0, digestTime: '08:30' });

  expect(response.status).toBe(422);
  expect(response.body.error).toMatchObject({
    code: 'E-VALIDATION',
    details: [{ field: 'budgetPerHour', issue: 'invalid' }],
  });
});

test('PUT /settings accepts a window crossing midnight, returns saved settings and writes one config audit row', async () => {
  const response = await supertest(app)
    .put('/api/v1/settings')
    .set('Cookie', cookie)
    .send({ quietStart: '22:00', quietEnd: '06:00', budgetPerHour: 8, digestTime: '09:00' });

  expect(response.status).toBe(200);
  expect(response.body.data).toEqual({
    quietStart: '22:00',
    quietEnd: '06:00',
    budgetPerHour: 8,
    digestTime: '09:00',
    holdSeconds: 60,
    timezone: 'Asia/Jakarta',
    contextWindowMinutes: 30,
    contextMaxMessages: 10,
    messageTextAccess: false,
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM config_audit WHERE table_name = 'policies'",
      )
    ).rows,
  ).toEqual([{ count: 1 }]);
});

const quietHours = {
  quietStart: '21:00',
  quietEnd: '07:00',
  budgetPerHour: 6,
  digestTime: '08:30',
};
const storedContext = async () =>
  (
    await pool.query(
      `SELECT key, value::int AS value FROM thresholds
       WHERE workspace_id = (SELECT id FROM workspaces LIMIT 1) AND scope = 'workspace'
         AND key IN ('context_window_minutes', 'context_max_messages') ORDER BY key`,
    )
  ).rows;

test('SRS §6.7 (FR-UI-21): the context window and message cap read with defaults, are saved to thresholds, and are kept when omitted', async () => {
  expect(await supertest(app).get('/api/v1/settings').set('Cookie', cookie)).toMatchObject({
    body: { data: { contextWindowMinutes: 30, contextMaxMessages: 10 } },
  });

  const saved = await supertest(app)
    .put('/api/v1/settings')
    .set('Cookie', cookie)
    .send({ ...quietHours, contextWindowMinutes: 0, contextMaxMessages: 5 });

  expect(saved.status).toBe(200);
  expect(saved.body.data).toMatchObject({ contextWindowMinutes: 0, contextMaxMessages: 5 });
  expect(await storedContext()).toEqual([
    { key: 'context_max_messages', value: 5 },
    { key: 'context_window_minutes', value: 0 },
  ]);

  const omitted = await supertest(app)
    .put('/api/v1/settings')
    .set('Cookie', cookie)
    .send(quietHours);

  expect(omitted.status).toBe(200);
  expect(omitted.body.data).toMatchObject({ contextWindowMinutes: 0, contextMaxMessages: 5 });
});

test.each([
  [180, 30],
  [0, 1],
])(
  'SRS §6.7 (FR-UI-21): a context window of %i minutes and a cap of %i messages are accepted',
  async (minutes, messages) => {
    const response = await supertest(app)
      .put('/api/v1/settings')
      .set('Cookie', cookie)
      .send({ ...quietHours, contextWindowMinutes: minutes, contextMaxMessages: messages });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      contextWindowMinutes: minutes,
      contextMaxMessages: messages,
    });
  },
);

test.each([
  { contextWindowMinutes: 181 },
  { contextWindowMinutes: -1 },
  { contextWindowMinutes: 1.5 },
  { contextMaxMessages: 0 },
  { contextMaxMessages: 31 },
  { notASetting: true },
])('SRS §6.7 (FR-UI-21): %j is refused with E-VALIDATION and stores nothing', async (extra) => {
  const before = await storedContext();
  const response = await supertest(app)
    .put('/api/v1/settings')
    .set('Cookie', cookie)
    .send({ ...quietHours, ...extra });

  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe('E-VALIDATION');
  expect(await storedContext()).toEqual(before);
});

test('SRS §6.7 (FR-UI-21): the context values of another workspace are never changed by a save', async () => {
  await pool.query(
    "INSERT INTO workspaces (id, name, timezone) VALUES ('00000000-0000-4000-8000-0000000007f1', 'Other', 'Asia/Jakarta')",
  );
  await pool.query(
    "INSERT INTO thresholds (workspace_id, scope, key, value) VALUES ('00000000-0000-4000-8000-0000000007f1', 'workspace', 'context_window_minutes', 45)",
  );

  await supertest(app)
    .put('/api/v1/settings')
    .set('Cookie', cookie)
    .send({ ...quietHours, contextWindowMinutes: 7 });

  expect(
    (
      await pool.query(
        "SELECT value::int AS value FROM thresholds WHERE workspace_id = '00000000-0000-4000-8000-0000000007f1' AND key = 'context_window_minutes'",
      )
    ).rows,
  ).toEqual([{ value: 45 }]);
  await pool.query(
    "DELETE FROM thresholds WHERE workspace_id = '00000000-0000-4000-8000-0000000007f1'",
  );
  await pool.query("DELETE FROM workspaces WHERE id = '00000000-0000-4000-8000-0000000007f1'");
});

test('SRS §11.4 (FR-UI-21): the one config audit row of a save carries both context values in after', async () => {
  await supertest(app)
    .put('/api/v1/settings')
    .set('Cookie', cookie)
    .send({ ...quietHours, contextWindowMinutes: 12, contextMaxMessages: 4 });

  const latest = await pool.query(
    "SELECT after FROM config_audit WHERE table_name = 'policies' ORDER BY created_at DESC LIMIT 1",
  );

  expect(latest.rows[0]?.after).toMatchObject({ contextWindowMinutes: 12, contextMaxMessages: 4 });
});

test.each(['id', 'workspaceId', 'level'])(
  'PUT /settings refuses server-owned %s',
  async (field) => {
    const audit = await pool.query('SELECT id FROM config_audit ORDER BY id');
    const response = await supertest(app)
      .put('/api/v1/settings')
      .set('Cookie', cookie)
      .send({
        quietStart: '21:00',
        quietEnd: '07:00',
        budgetPerHour: 6,
        digestTime: '08:30',
        [field]: 'client-owned-value',
      });

    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: 'E-VALIDATION',
      details: [{ field, issue: 'unknown' }],
    });
    expect((await pool.query('SELECT id FROM config_audit ORDER BY id')).rows).toEqual(audit.rows);
  },
);

test('GET /settings/mail reports waiting digest items before a mail server is configured', async () => {
  const response = await supertest(app).get('/api/v1/settings/mail').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ data: null, pendingDigestItems: 4 });
});

test('the first mail save requires a password before attempting SMTP verification', async () => {
  const response = await supertest(app).put('/api/v1/settings/mail').set('Cookie', cookie).send({
    host: mailInput.host,
    port: mailInput.port,
    username: mailInput.username,
    fromAddress: mailInput.fromAddress,
  });

  expect(response.status).toBe(422);
  expect(response.body.error).toMatchObject({
    code: 'E-VALIDATION',
    details: [{ field: 'password', issue: 'invalid' }],
  });
  expect(verifyMail).not.toHaveBeenCalled();
});

test('PUT /settings/mail returns E-MAIL-CONNECTION-FAILED and stores nothing when login is refused', async () => {
  verifyMail.mockRejectedValueOnce(new Error(`SMTP refused ${mailPassword}`));
  const response = await supertest(app)
    .put('/api/v1/settings/mail')
    .set('Cookie', cookie)
    .send(mailInput);

  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe('E-MAIL-CONNECTION-FAILED');
  expect(JSON.stringify(response.body)).not.toContain(mailPassword);
  expect((await pool.query('SELECT id FROM mail_connections')).rows).toEqual([]);
  expect((await pool.query("SELECT id FROM secrets WHERE purpose = 'mail_password'")).rows).toEqual(
    [],
  );
});

test('PUT /settings/mail verifies the login, encrypts the password and returns only safe fields', async () => {
  const queries = vi.spyOn(Client.prototype, 'query');

  verifyMail.mockResolvedValueOnce(undefined);
  const response = await supertest(app)
    .put('/api/v1/settings/mail')
    .set('Cookie', cookie)
    .send(mailInput);

  expect(response.status).toBe(200);
  expect(verifyMail).toHaveBeenLastCalledWith({
    host: mailInput.host,
    port: mailInput.port,
    username: mailInput.username,
    password: mailPassword,
  });
  const insert = queries.mock.calls.findIndex(
    ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO secrets'),
  );

  expect(insert).toBeGreaterThanOrEqual(0);
  expect(queries.mock.invocationCallOrder[insert]).toBeGreaterThan(
    verifyMail.mock.invocationCallOrder.at(-1) ?? 0,
  );
  expect(response.body.data).toEqual({
    host: mailInput.host,
    port: mailInput.port,
    username: mailInput.username,
    fromAddress: mailInput.fromAddress,
    passwordPresent: true,
    verifiedAt: '2026-10-10T04:01:00.000Z',
  });
  const secret = (
    await pool.query<{ ciphertext: Buffer }>(
      "SELECT ciphertext FROM secrets WHERE purpose = 'mail_password'",
    )
  ).rows[0];

  expect(secret.ciphertext.includes(Buffer.from(mailPassword))).toBe(false);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM config_audit WHERE table_name = 'mail_connections'",
      )
    ).rows,
  ).toEqual([{ count: 1 }]);
});

test('a later mail save retains the stored password when it is omitted', async () => {
  const before = await pool.query(
    "SELECT id, ciphertext, nonce FROM secrets WHERE purpose = 'mail_password'",
  );

  verifyMail.mockResolvedValueOnce(undefined);
  const input = {
    host: mailInput.host,
    port: mailInput.port,
    username: mailInput.username,
    fromAddress: 'dispatch@pointstar.example',
  };
  const response = await supertest(app)
    .put('/api/v1/settings/mail')
    .set('Cookie', cookie)
    .send(input);

  expect(response.status).toBe(200);
  expect(verifyMail).toHaveBeenLastCalledWith({
    host: input.host,
    port: input.port,
    username: input.username,
    password: mailPassword,
  });
  expect(
    (await pool.query("SELECT id, ciphertext, nonce FROM secrets WHERE purpose = 'mail_password'"))
      .rows,
  ).toEqual(before.rows);
  const read = await supertest(app).get('/api/v1/settings/mail').set('Cookie', cookie);

  expect(read.body.data).toEqual({
    ...input,
    passwordPresent: true,
    verifiedAt: '2026-10-10T04:01:00.000Z',
  });
});

test('a refused replacement preserves the existing configuration and encrypted secret', async () => {
  const before = await pool.query('SELECT * FROM mail_connections');
  const secret = await pool.query("SELECT * FROM secrets WHERE purpose = 'mail_password'");
  const audit = await pool.query('SELECT id FROM config_audit ORDER BY id');

  verifyMail.mockRejectedValueOnce(new Error('test-only SMTP refusal'));
  const response = await supertest(app)
    .put('/api/v1/settings/mail')
    .set('Cookie', cookie)
    .send({ ...mailInput, password: 'replacement-test-password' });

  expect(response.status).toBe(422);
  expect((await pool.query('SELECT * FROM mail_connections')).rows).toEqual(before.rows);
  expect((await pool.query("SELECT * FROM secrets WHERE purpose = 'mail_password'")).rows).toEqual(
    secret.rows,
  );
  expect((await pool.query('SELECT id FROM config_audit ORDER BY id')).rows).toEqual(audit.rows);
});

test('AC22: GET /settings reports messageTextAccess false on the seed', async () => {
  const response = await supertest(app).get('/api/v1/settings').set('Cookie', cookie);

  expect(response.status).toBe(200);
  expect(response.body.data.messageTextAccess).toBe(false);
});

test('AC22: PUT /settings with messageTextAccess true stores it and records the change in one config audit row', async () => {
  const response = await supertest(app)
    .put('/api/v1/settings')
    .set('Cookie', cookie)
    .send({ ...quietHours, messageTextAccess: true });

  expect(response.status).toBe(200);
  expect(response.body.data.messageTextAccess).toBe(true);
  expect((await pool.query('SELECT message_text_access FROM policies')).rows).toEqual([
    { message_text_access: true },
  ]);
  const [audit] = (
    await pool.query(
      "SELECT actor_id, before, after FROM config_audit WHERE table_name = 'policies' ORDER BY created_at DESC",
    )
  ).rows;

  expect(audit.before).toMatchObject({ messageTextAccess: false });
  expect(audit.after).toMatchObject({ messageTextAccess: true });
  expect(audit.actor_id).toEqual(
    (await pool.query("SELECT id FROM people WHERE name = 'Siti Aminah'")).rows[0].id,
  );
});

test('AC22: PUT /settings without messageTextAccess keeps the stored value, and a non-boolean returns 422', async () => {
  const kept = await supertest(app).put('/api/v1/settings').set('Cookie', cookie).send(quietHours);

  expect(kept.status).toBe(200);
  expect(kept.body.data.messageTextAccess).toBe(true);

  const refused = await supertest(app)
    .put('/api/v1/settings')
    .set('Cookie', cookie)
    .send({ ...quietHours, messageTextAccess: 'yes' });

  expect(refused.status).toBe(422);
});
