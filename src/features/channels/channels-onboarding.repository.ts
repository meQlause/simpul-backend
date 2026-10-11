import type { PoolClient } from 'pg';

export async function selectActiveVerifiedGroup(tx: PoolClient, workspaceId: string) {
  const result = await tx.query(
    `SELECT c.id FROM channels c JOIN bot_connections b ON b.id = c.bot_connection_id AND b.workspace_id = $1
    WHERE c.workspace_id = $1 AND c.connection_status = 'active' AND c.monitored AND c.verified_config_version = c.config_version
    AND EXISTS (SELECT 1 FROM channel_verifications v WHERE v.workspace_id = $1 AND v.channel_id = c.id AND v.bot_connection_id = b.id
      AND v.status = 'pass' AND v.config_version = c.config_version AND v.credential_version = b.credential_version)
    LIMIT 1 FOR SHARE OF c, b`,
    [workspaceId],
  );

  return result.rowCount === 1;
}
