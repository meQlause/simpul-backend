import type { Pool } from 'pg';
import { openTenantPool, type TenantPoolOptions } from './tenant-pool.js';
import { checkTenantDatabase } from './database-preflight.js';
import { DomainError } from '../errors/domain-error.js';

export type DatabaseServices = TenantPoolOptions & {
  systemPool: Pool;
  masterKey: string;
  now: () => Date;
  invalidate?: (workspaceId: string) => Promise<void>;
};

const SETUP_TIMEOUT_MS = 10000;

export async function withDatabaseSetup<Result>(
  input: { connectionString: string; workspaceId: string; pending: boolean },
  services: DatabaseServices,
  operation: (pool: Pool) => Promise<Result>,
) {
  let pool: Pool | undefined;

  try {
    pool = await openTenantPool(input.connectionString, services, SETUP_TIMEOUT_MS);
    await checkTenantDatabase(pool, input.workspaceId, input.pending);

    return await operation(pool);
  } catch (error) {
    throw error instanceof DomainError ? error : new DomainError('E-DB-CONNECTION-FAILED');
  } finally {
    await pool?.end().catch(() => {});
  }
}
