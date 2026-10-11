import type { PoolClient } from 'pg';

export async function insertPendingDatabase(
  tx: PoolClient,
  input: { workspaceId: string; name: string; timezone: string; authUserId: string; now: Date },
) {
  await tx.query(
    `INSERT INTO workspace_databases
    (workspace_id, workspace_name, timezone, admin_auth_user_id, updated_at)
    VALUES ($1, $2, $3, $4, $5)`,
    [input.workspaceId, input.name, input.timezone, input.authUserId, input.now],
  );
}

export async function databaseStatus(tx: PoolClient, workspaceId: string) {
  const result = await tx.query<{ status: string }>(
    'SELECT status FROM workspace_databases WHERE workspace_id = $1',
    [workspaceId],
  );

  return result.rows[0]?.status;
}

export type WorkspaceDatabase = {
  workspace_id: string;
  status: 'pending' | 'connected' | 'unreachable' | 'migration_failed';
  url_secret_ref: string | null;
  schema_version: string | null;
  workspace_name: string;
  timezone: string;
  admin_auth_user_id: string;
  host: string | null;
  port: number | null;
  database_name: string | null;
  connection_version: string | null;
};

export async function selectWorkspaceDatabase(tx: PoolClient, workspaceId: string) {
  const result = await tx.query<WorkspaceDatabase>(
    `SELECT registry.*, encode(secret.nonce, 'hex') AS connection_version
    FROM workspace_databases registry LEFT JOIN secrets secret ON secret.id = registry.url_secret_ref
    AND secret.workspace_id = registry.workspace_id WHERE registry.workspace_id = $1`,
    [workspaceId],
  );

  return result.rows[0];
}

export async function lockDatabaseSetup(tx: PoolClient, workspaceId: string) {
  const result = await tx.query<WorkspaceDatabase & { admin_name: string; admin_email: string }>(
    `SELECT registry.*, admin.name AS admin_name, admin.email AS admin_email
    FROM workspace_databases registry JOIN "user" admin ON admin.id = registry.admin_auth_user_id
    WHERE registry.workspace_id = $1 FOR UPDATE OF registry`,
    [workspaceId],
  );

  return result.rows[0];
}

export async function connectDatabaseRegistry(
  tx: PoolClient,
  input: {
    workspaceId: string;
    urlSecretRef: string;
    url: URL;
    version: string;
    authUserId: string;
    now: Date;
  },
) {
  await tx.query(
    `UPDATE workspace_databases SET status = 'connected', url_secret_ref = $2,
    host = $3, port = $4, database_name = $5, schema_version = $6,
    availability_ack_at = coalesce(availability_ack_at, $7),
    availability_ack_by = coalesce(availability_ack_by, $8), connected_at = coalesce(connected_at, $7),
    unreachable_since = NULL, probe_streak = 0, updated_at = $7 WHERE workspace_id = $1`,
    [
      input.workspaceId,
      input.urlSecretRef,
      input.url.hostname,
      Number(input.url.port || '5432'),
      decodeURIComponent(input.url.pathname.slice(1)),
      input.version,
      input.now,
      input.authUserId,
    ],
  );
}

export async function databaseSummary(tx: PoolClient, workspaceId: string) {
  const result = await tx.query(
    `SELECT 'own' AS mode, status, host, port, database_name AS "databaseName",
    schema_version AS "schemaVersion", availability_ack_at AS "availabilityAckAt",
    connected_at AS "connectedAt", unreachable_since AS "unreachableSince"
    FROM workspace_databases WHERE workspace_id = $1`,
    [workspaceId],
  );

  return result.rows[0];
}

export async function lockDatabaseProbe(tx: PoolClient, workspaceId: string) {
  const result = await tx.query<{
    workspace_name: string;
    host: string;
    email: string;
    status: 'connected' | 'unreachable';
    probe_streak: number;
    url_secret_ref: string;
  }>(
    `SELECT registry.workspace_name, registry.host, admin.email, registry.status,
      registry.probe_streak, registry.url_secret_ref FROM workspace_databases registry
      JOIN "user" admin ON admin.id = registry.admin_auth_user_id
      WHERE registry.workspace_id = $1 AND registry.status IN ('connected', 'unreachable')
      FOR UPDATE OF registry`,
    [workspaceId],
  );

  return result.rows[0];
}

export async function updateDatabaseProbe(
  tx: PoolClient,
  workspaceId: string,
  state: { status: string; streak: number },
  now: Date,
) {
  await tx.query(
    `UPDATE workspace_databases SET status = $2, probe_streak = $3,
    unreachable_since = CASE WHEN $2 = 'unreachable' THEN coalesce(unreachable_since, $4) ELSE NULL END,
    updated_at = $4 WHERE workspace_id = $1`,
    [workspaceId, state.status, state.streak, now],
  );
}

export async function updateDatabaseMigration(
  tx: PoolClient,
  workspaceId: string,
  version: string | null,
  now: Date,
) {
  await tx.query(
    `UPDATE workspace_databases SET status = CASE WHEN $2::text IS NULL THEN 'migration_failed' ELSE 'connected' END,
    schema_version = coalesce($2, schema_version), probe_streak = 0, unreachable_since = NULL, updated_at = $3
    WHERE workspace_id = $1`,
    [workspaceId, version, now],
  );
}
