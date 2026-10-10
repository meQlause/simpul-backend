import { beforeAll, expect, test } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { transactionFixture } from '../../../helpers/transactions.js';
import { recordConfigChange } from '../../../../src/features/audit/index.js';

const pool = databaseFixture();
const workspaceId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000002';
const transaction = transactionFixture(pool);
const secret = 'test-secret-must-not-be-audited';

beforeAll(async () => {
  await applyMigrations(pool);
  await pool.query(
    "INSERT INTO workspaces (id, name, timezone) VALUES ($1, 'Audit test', 'Asia/Jakarta')",
    [workspaceId],
  );
  await pool.query("INSERT INTO people (id, workspace_id, name) VALUES ($1, $2, 'Test admin')", [
    actorId,
    workspaceId,
  ]);
}, 120000);

test.each([
  ['workspaces', { name: 'Audit test', timezone: 'Asia/Jakarta' }],
  ['policies', { quietStart: '21:00', quietEnd: '07:00', budgetPerHour: 6, digestTime: '08:30' }],
  [
    'people',
    {
      name: 'Test person',
      availability: 'leave',
      role: { id: actorId, name: 'Role', team: 'Team', token: secret },
    },
  ],
  [
    'mail_connections',
    {
      host: 'smtp.example.test',
      port: 587,
      username: 'test-user',
      fromAddress: 'test@example.test',
    },
  ],
] as const)('config audit permits only safe fields for %s', async (tableName, visible) => {
  const payload = {
    ...visible,
    password: secret,
    tokenSecretRef: secret,
    credentials: { password: secret },
  };
  await recordConfigChange(transaction(), {
    workspaceId,
    actorId,
    recordId: actorId,
    tableName,
    before: payload,
    after: payload,
  });
  const rows = await transaction().query(
    'SELECT actor_id, table_name, "before", "after" FROM config_audit',
  );
  expect(rows.rows).toHaveLength(1);
  expect(JSON.stringify(rows.rows)).not.toContain(secret);
  expect(rows.rows[0]).toMatchObject({ actor_id: actorId, table_name: tableName });
  const expected =
    'role' in visible ? { ...visible, role: { id: actorId, name: 'Role', team: 'Team' } } : visible;
  expect(rows.rows[0].before).toEqual(expected);
  expect(rows.rows[0].after).toEqual(expected);
});
