import type { Pool, PoolClient } from 'pg';
import { DomainError } from '../errors/domain-error.js';

const MIN_VERSION = 150000;
const PERMISSION_MISSING = 'E-DB-PERMISSION-MISSING';

async function assertPermissions(tx: PoolClient) {
  const result = await tx.query<{ allowed: boolean }>(`SELECT
    has_schema_privilege(current_user, 'public', 'CREATE')
    AND has_database_privilege(current_user, current_database(), 'CREATE') AS allowed`);

  if (!result.rows[0].allowed) {
    throw new DomainError(PERMISSION_MISSING);
  }
}

async function assertVector(tx: PoolClient) {
  const result = await tx.query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'");

  if (!result.rowCount) {
    throw new DomainError('E-DB-VECTOR-MISSING');
  }

  try {
    await tx.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
  } catch {
    throw new DomainError(PERMISSION_MISSING);
  }
}

async function assertWorkspaceDatabase(tx: PoolClient, workspaceId: string, pending: boolean) {
  const table = await tx.query("SELECT to_regclass('public.workspaces') AS name");

  if (!table.rows[0].name && pending) {
    return;
  }

  const code = pending ? 'E-DB-IN-USE' : 'E-DB-WORKSPACE-MISMATCH';

  if (!table.rows[0].name) {
    throw new DomainError(code);
  }

  await tx.query('SET LOCAL row_security = off');
  const result = await tx.query<{ id: string }>('SELECT id FROM public.workspaces');

  if (result.rows.length !== 1 || result.rows[0].id !== workspaceId) {
    throw new DomainError(code);
  }
}

export async function checkTenantDatabase(pool: Pool, workspaceId: string, pending: boolean) {
  const version = await pool.query<{ server_version_num: string }>('SHOW server_version_num');

  if (Number(version.rows[0].server_version_num) < MIN_VERSION) {
    throw new DomainError('E-DB-VERSION-UNSUPPORTED');
  }

  const tx = await pool.connect();

  try {
    await tx.query('BEGIN');
    await assertPermissions(tx);
    await assertVector(tx);
    await assertWorkspaceDatabase(tx, workspaceId, pending);
  } finally {
    try {
      await tx.query('ROLLBACK');
    } finally {
      tx.release();
    }
  }
}
