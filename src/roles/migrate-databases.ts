import type { ProbeServices } from '../platform/db/database-probe.job.js';
import { scopedTransaction } from '../platform/db/scoped-transaction.js';
import { migrateTenant, schemaVersion } from '../platform/db/migrate-tenant.js';
import { openTenantPool } from '../platform/db/tenant-pool.js';
import {
  lockDatabaseProbe,
  updateDatabaseMigration,
} from '../platform/db/workspace-databases.repository.js';
import { databaseNotice } from '../platform/mail/database-notice.js';
import { checkTenantDatabase } from '../platform/db/database-preflight.js';

const SYSTEM_SCOPE = '00000000-0000-4000-8000-000000000000';

async function migrateCustomer(url: string, workspaceId: string, services: ProbeServices) {
  const pool = await openTenantPool(url, services);

  try {
    await checkTenantDatabase(pool, workspaceId, false);
    await scopedTransaction(async () => pool, workspaceId, migrateTenant);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function migrateOwn(services: ProbeServices, workspaceId: string) {
  return scopedTransaction(
    async () => services.systemPool,
    workspaceId,
    async (tx) => {
      const row = await lockDatabaseProbe(tx, workspaceId);

      if (!row || row.status !== 'connected') {
        return;
      }

      let failed = false;

      try {
        const url = await services.secretStore.get(
          tx,
          workspaceId,
          'database_url',
          row.url_secret_ref,
        );

        await migrateCustomer(url, workspaceId, services);
      } catch {
        failed = true;
      }

      const now = services.now();

      await updateDatabaseMigration(tx, workspaceId, failed ? null : schemaVersion, now);

      if (failed) {
        services.alert?.({ workspaceId, code: 'E-DB-MIGRATION-FAILED' });

        return databaseNotice({
          workspaceId,
          workspaceName: row.workspace_name,
          host: row.host,
          email: row.email,
          status: 'migration_failed',
          time: now.toISOString(),
        });
      }
    },
  );
}

async function migrateAndNotify(services: ProbeServices, workspaceId: string) {
  try {
    const notice = await migrateOwn(services, workspaceId);

    if (notice) {
      await services.sendMail(notice);

      return true;
    }

    return false;
  } catch {
    services.alert?.({ workspaceId, code: 'E-DB-MIGRATION-FAILED' });

    return true;
  }
}

export async function migrateDatabases(services: ProbeServices) {
  await scopedTransaction(async () => services.systemPool, SYSTEM_SCOPE, migrateTenant);
  const rows = (
    await services.systemPool.query<{ workspace_id: string }>(
      'SELECT * FROM own_database_workspaces()',
    )
  ).rows;
  const failed: string[] = [];

  for (const row of rows) {
    if (await migrateAndNotify(services, row.workspace_id)) {
      failed.push(row.workspace_id);
    }
  }

  return failed;
}
