import type { Pool } from 'pg';
import { openTenantPool, type TenantPoolOptions } from './tenant-pool.js';
import { checkTenantDatabase } from './database-preflight.js';
import { DomainError } from '../errors/domain-error.js';

export type DatabaseServices = TenantPoolOptions & {
  systemPool: Pool;
  masterKey: string;
  now: () => Date;
};

const SETUP_TIMEOUT_MS = 10000;

export async function checkDatabaseSetup(
  input: { connectionString: string; workspaceId: string; pending: boolean },
  services: DatabaseServices,
) {
  let pool: Pool | undefined;

  try {
    pool = await openTenantPool(input.connectionString, services, SETUP_TIMEOUT_MS);
    await checkTenantDatabase(pool, input.workspaceId, input.pending);
  } catch (error) {
    throw error instanceof DomainError ? error : new DomainError('E-DB-CONNECTION-FAILED');
  } finally {
    await pool?.end().catch(() => {});
  }
}
