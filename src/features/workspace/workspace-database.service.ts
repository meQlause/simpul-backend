import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { scopedTransaction } from '../../platform/db/scoped-transaction.js';
import { withDatabaseSetup, type DatabaseServices } from '../../platform/db/database-setup.js';
import {
  lockDatabaseSetup,
  connectDatabaseRegistry,
  databaseSummary,
} from '../../platform/db/workspace-databases.repository.js';
import { migrateTenant, schemaVersion } from '../../platform/db/migrate-tenant.js';
import { createSecretStore } from '../../platform/secrets/index.js';
import { initializeBusinessWorkspace } from './workspace.service.js';
import { workspaceAdmin } from './workspace.repository.js';
import { parseDatabaseConnection } from './workspace-database.schema.js';
import { DomainError } from '../../platform/errors/domain-error.js';
import { createQueue } from '../../platform/queue/index.js';

type Setup = NonNullable<Awaited<ReturnType<typeof lockDatabaseSetup>>>;

async function provisionDatabase(tx: PoolClient, row: Setup, now: Date) {
  await migrateTenant(tx);
  const existing = await workspaceAdmin(tx, row.workspace_id);

  if (existing) {
    if (existing.auth_user_id !== row.admin_auth_user_id) {
      throw new DomainError('E-DB-IN-USE');
    }

    return;
  }

  await initializeBusinessWorkspace(
    tx,
    {
      workspaceId: row.workspace_id,
      adminId: randomUUID(),
      authUserId: row.admin_auth_user_id,
      now,
      input: {
        name: row.workspace_name,
        timezone: row.timezone,
        'admin-name': row.admin_name,
        'admin-email': row.admin_email,
      },
    },
    { availabilityAckAt: now.toISOString(), availabilityAckBy: row.admin_auth_user_id },
  );
}

async function initializeDatabase(pool: Pool, row: Setup, now: Date) {
  await scopedTransaction(
    async () => pool,
    row.workspace_id,
    (tx) => provisionDatabase(tx, row, now),
  );
  const queue = await createQueue(pool);

  await queue.stop();
}

export async function saveDatabase(services: DatabaseServices, workspaceId: string, body: unknown) {
  return scopedTransaction(
    async () => services.systemPool,
    workspaceId,
    async (systemTx) => {
      const row = await lockDatabaseSetup(systemTx, workspaceId);
      const input = parseDatabaseConnection(body, row?.status === 'pending');

      if (!row) {
        throw new DomainError('E-NOT-FOUND');
      }

      const now = services.now();

      await withDatabaseSetup(
        {
          connectionString: input.connectionString,
          workspaceId,
          pending: row.status === 'pending',
        },
        services,
        (pool) => initializeDatabase(pool, row, now),
      );
      const ref = await createSecretStore(services.masterKey).put(systemTx, workspaceId, {
        purpose: 'database_url',
        value: input.connectionString,
        id: row.url_secret_ref ?? undefined,
      });

      await connectDatabaseRegistry(systemTx, {
        workspaceId,
        urlSecretRef: ref,
        url: new URL(input.connectionString),
        version: schemaVersion,
        authUserId: row.admin_auth_user_id,
        now,
      });

      return databaseSummary(systemTx, workspaceId);
    },
  );
}
