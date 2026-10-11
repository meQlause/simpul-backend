import { beforeAll, expect, test } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { transactionFixture } from '../../../helpers/transactions.js';

const pool = databaseFixture();
const transaction = transactionFixture(pool);
const workspaceId = '00000000-0000-4000-8000-000000000001';
const secretId = '00000000-0000-4000-8000-000000000002';
const instant = '2026-10-10T04:01:00Z';

beforeAll(async () => {
  await applyMigrations(pool);
  await pool.query(`INSERT INTO workspace_keys (workspace_id, wrapped_key) VALUES ($1, $2)`, [
    workspaceId,
    Buffer.from('wrapped-test-key'),
  ]);
  await pool.query(
    `INSERT INTO secrets (id, workspace_id, purpose, ciphertext, nonce)
    VALUES ($1, $2, 'database_url', $3, $4)`,
    [secretId, workspaceId, Buffer.from('test-ciphertext'), Buffer.alloc(12)],
  );
}, 120000);

test.each([
  {
    status: 'connected',
    reference: secretId,
    acknowledgement: null,
    outage: null,
    constraint: 'wsdb_ack_before_connection',
  },
  {
    status: 'pending',
    reference: secretId,
    acknowledgement: instant,
    outage: null,
    constraint: 'wsdb_status_matches_state',
  },
  {
    status: 'connected',
    reference: null,
    acknowledgement: instant,
    outage: null,
    constraint: 'wsdb_status_matches_state',
  },
  {
    status: 'unreachable',
    reference: secretId,
    acknowledgement: instant,
    outage: null,
    constraint: 'wsdb_status_matches_state',
  },
  {
    status: 'connected',
    reference: secretId,
    acknowledgement: instant,
    outage: instant,
    constraint: 'wsdb_status_matches_state',
  },
  {
    status: 'migration_failed',
    reference: null,
    acknowledgement: instant,
    outage: null,
    constraint: 'wsdb_status_matches_state',
  },
])(
  'A $status workspace database row cannot violate $constraint',
  async ({ status, reference, acknowledgement, outage, constraint }) => {
    await expect(
      transaction().query(
        `INSERT INTO workspace_databases
    (workspace_id, workspace_name, timezone, admin_auth_user_id, status, url_secret_ref,
      availability_ack_at, unreachable_since) VALUES ($1, 'Own workspace', 'Asia/Jakarta', 'test-admin', $2, $3, $4, $5)`,
        [workspaceId, status, reference, acknowledgement, outage],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint });
  },
);

test.each([
  ['pending', null, null, null],
  ['connected', secretId, instant, null],
  ['unreachable', secretId, instant, instant],
  ['migration_failed', secretId, instant, null],
])(
  'A valid %s workspace database state can be stored',
  async (status, reference, acknowledgement, outage) => {
    const result = await transaction().query(
      `INSERT INTO workspace_databases
    (workspace_id, workspace_name, timezone, admin_auth_user_id, status, url_secret_ref,
      availability_ack_at, unreachable_since) VALUES ($1, 'Own workspace', 'Asia/Jakarta', 'test-admin', $2, $3, $4, $5)
      RETURNING status`,
      [workspaceId, status, reference, acknowledgement, outage],
    );

    expect(result.rows).toEqual([{ status }]);
  },
);
