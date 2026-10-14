import type { PoolClient } from 'pg';
import { DomainError } from '../errors/domain-error.js';

const tables = [
  'connection_routes',
  'workspace_databases',
  'config_audit',
  'idempotency_keys',
  'message_access_log',
  'unit_corrections',
  'corrections',
  'decisions',
  'digest_items',
  'notifications',
  'digests',
  'review_items',
  'open_questions',
  'progress_markers',
  'label_rule_matches',
  'labels',
  'orphans',
  'message_thread_link',
  'unit_embeddings',
  'unit_messages',
  'media_outcomes',
  'unit_resolutions',
  'messages_raw',
  'units',
  'threads',
  'edges',
  'nodes',
  'rules',
  'aliases',
  'thresholds',
  'display_id_counters',
  'templates',
  'role_members',
  'person_identities',
  'channel_connection_sessions',
  'channel_verifications',
  'provider_updates',
  'channels',
  'bot_connections',
  'mail_connections',
  'secrets',
  'workspace_keys',
  'people',
  'roles',
  'vocab_domains',
  'policies',
];

export async function lockWorkspace(tx: PoolClient, workspaceId: string) {
  const result = await tx.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [
    workspaceId,
  ]);

  return result.rowCount === 1;
}

export async function checkErasureInventory(tx: PoolClient) {
  const inventory = await tx.query<{ table_name: string; privileged: boolean }>(
    `SELECT columns.table_name, pg_has_role(current_user, relation.relowner, 'USAGE') OR role.rolbypassrls AS privileged
    FROM information_schema.columns columns JOIN pg_namespace schema ON schema.nspname = columns.table_schema
    JOIN pg_class relation ON relation.relnamespace = schema.oid AND relation.relname = columns.table_name
    JOIN pg_roles role ON role.rolname = current_user
    WHERE columns.table_schema = 'public' AND columns.column_name = 'workspace_id'`,
  );

  if (
    inventory.rows.length !== tables.length ||
    inventory.rows.some((row) => !tables.includes(row.table_name) || !row.privileged)
  ) {
    throw new DomainError('E-FORBIDDEN');
  }
}

export async function eraseAuth(tx: PoolClient, workspaceId: string) {
  await tx.query(
    `DELETE FROM verification WHERE value IN (SELECT auth_user_id FROM people WHERE workspace_id = $1)
    OR identifier IN (SELECT u.email FROM "user" u JOIN people p ON p.auth_user_id = u.id WHERE p.workspace_id = $1)`,
    [workspaceId],
  );
  await tx.query(
    'DELETE FROM "user" WHERE id IN (SELECT auth_user_id FROM people WHERE workspace_id = $1)',
    [workspaceId],
  );
}

export async function lockTenantRows(tx: PoolClient, workspaceId: string) {
  for (const table of tables) {
    await tx.query(
      `SELECT count(*) FROM (SELECT 1 FROM "${table}" WHERE workspace_id = $1 FOR UPDATE) locked`,
      [workspaceId],
    );
  }
}

export async function eraseTenantRows(tx: PoolClient, workspaceId: string) {
  await tx.query('UPDATE workspaces SET admin_person_id = NULL WHERE id = $1', [workspaceId]);

  for (const table of tables) {
    await tx.query(`DELETE FROM "${table}" WHERE workspace_id = $1`, [workspaceId]);
  }

  await tx.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
}

export async function eraseJobs(tx: PoolClient, workspaceId: string) {
  const exists = await tx.query("SELECT to_regclass('pgboss.job') AS table");

  if (exists.rows[0].table) {
    await tx.query("DELETE FROM pgboss.job WHERE data->>'workspaceId' = $1", [workspaceId]);
  }
}
