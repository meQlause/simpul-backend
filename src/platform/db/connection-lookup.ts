import type { Pool } from 'pg';

export function createConnectionLookup(pool: Pool) {
  return async (connectionId: string) => {
    const result = await pool.query<{ workspaceId: string; webhookSecretRef: string }>(
      'SELECT workspace_id AS "workspaceId", webhook_secret_ref AS "webhookSecretRef" FROM workspace_for_connection($1)',
      [connectionId],
    );

    return result.rows[0];
  };
}
