import type { PoolClient } from 'pg';

export async function storedAccount(tx: PoolClient, workspaceId: string) {
  const result = await tx.query<{ provider_account_id: string }>(
    "SELECT provider_account_id FROM bot_connections WHERE workspace_id = $1 AND provider = 'telegram'",
    [workspaceId],
  );
  return result.rows[0]?.provider_account_id;
}
