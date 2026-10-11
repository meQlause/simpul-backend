import type { Pool } from 'pg';
import type { ConnectionResolver } from './connection-resolver.js';
import { scopedTransaction } from './scoped-transaction.js';

export function createConnectionLookup(pool: Pool, resolveConnection?: ConnectionResolver) {
  return async (connectionId: string) => {
    const result = await pool.query<{ workspaceId: string; webhookSecretRef: string }>(
      'SELECT workspace_id AS "workspaceId", webhook_secret_ref AS "webhookSecretRef" FROM workspace_for_connection($1)',
      [connectionId],
    );

    if (result.rows[0] || !resolveConnection) {
      return result.rows[0];
    }

    const route = await pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM workspace_for_route($1)',
      [connectionId],
    );
    const workspaceId = route.rows[0]?.workspace_id;

    if (!workspaceId) {
      return undefined;
    }

    return scopedTransaction(resolveConnection, workspaceId, async (tx) => {
      const connection = await tx.query<{ workspaceId: string; webhookSecretRef: string }>(
        'SELECT workspace_id AS "workspaceId", webhook_secret_ref AS "webhookSecretRef" FROM bot_connections WHERE id = $1 AND workspace_id = $2',
        [connectionId, workspaceId],
      );

      return connection.rows[0];
    });
  };
}
