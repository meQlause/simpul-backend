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
