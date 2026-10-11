import type { Pool } from 'pg';
import type { createSecretStore } from '../secrets/index.js';
import { openTenantPool, type TenantPoolOptions } from './tenant-pool.js';
import { scopedTransaction } from './scoped-transaction.js';
import { lockDatabaseProbe, updateDatabaseProbe } from './workspace-databases.repository.js';
import { probeState } from './database-probe.rules.js';
import { databaseNotice } from '../mail/database-notice.js';

export type ProbeServices = TenantPoolOptions & {
  systemPool: Pool;
  secretStore: ReturnType<typeof createSecretStore>;
  now: () => Date;
  sendMail: (message: ReturnType<typeof databaseNotice>) => Promise<void>;
  alert?: (event: { workspaceId: string; code: string }) => void;
};

async function reachable(url: string, services: TenantPoolOptions) {
  let pool: Pool | undefined;

  try {
    pool = await openTenantPool(url, services);
    await pool.query('SELECT 1');

    return true;
  } catch {
    return false;
  } finally {
    await pool?.end().catch(() => {});
  }
}

async function probeDatabase(services: ProbeServices, workspaceId: string) {
  await scopedTransaction(
    async () => services.systemPool,
    workspaceId,
    async (tx) => {
      const row = await lockDatabaseProbe(tx, workspaceId);

      if (!row) {
        return;
      }

      const url = await services.secretStore.get(
        tx,
        workspaceId,
        'database_url',
        row.url_secret_ref,
      );
      const state = probeState(row.status, row.probe_streak, await reachable(url, services));
      const now = services.now();

      await updateDatabaseProbe(tx, workspaceId, state, now);

      if (state.changed) {
        await services.sendMail(
          databaseNotice({
            workspaceId,
            workspaceName: row.workspace_name,
            host: row.host,
            email: row.email,
            status: state.status,
            time: now.toISOString(),
          }),
        );
      }
    },
  );
}

export async function probeDatabases(services: ProbeServices) {
  const result = await services.systemPool.query<{ workspace_id: string }>(
    'SELECT * FROM own_database_probes()',
  );

  await Promise.all(
    result.rows.map(async (row) => {
      try {
        await probeDatabase(services, row.workspace_id);
      } catch {
        services.alert?.({ workspaceId: row.workspace_id, code: 'E-DB-UNAVAILABLE' });
      }
    }),
  );
}
