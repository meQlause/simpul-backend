import type { PoolClient } from 'pg';

type EditableChannel = {
  displayName: string;
  class: string;
  primaryLanguage: string;
  configVersion: number;
  connectionStatus: string;
  monitored: boolean;
};

export async function selectEditableChannel(
  tx: PoolClient,
  workspaceId: string,
  channelId: string,
) {
  const result = await tx.query<EditableChannel>(
    `SELECT display_name AS "displayName", class, primary_language AS "primaryLanguage", config_version AS "configVersion",
     connection_status AS "connectionStatus", monitored FROM channels WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [workspaceId, channelId],
  );
  return result.rows[0];
}

export async function storeChannelEdit(
  tx: PoolClient,
  workspaceId: string,
  channelId: string,
  next: EditableChannel & { clearReadiness: boolean },
) {
  await tx.query(
    `UPDATE channels SET display_name = $3, class = $4, primary_language = $5, config_version = $6,
     connection_status = $7, monitored = $8,
     verified_at = CASE WHEN $9 THEN NULL ELSE verified_at END,
     verified_config_version = CASE WHEN $9 THEN NULL ELSE verified_config_version END,
     privacy_mode_ok = CASE WHEN $9 THEN false ELSE privacy_mode_ok END
     WHERE workspace_id = $1 AND id = $2`,
    [
      workspaceId,
      channelId,
      next.displayName,
      next.class,
      next.primaryLanguage,
      next.configVersion,
      next.connectionStatus,
      next.monitored,
      next.clearReadiness,
    ],
  );
}
