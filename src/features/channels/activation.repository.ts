import type { PoolClient } from 'pg';
import type { ReadinessCheck } from '../../platform/providers/index.js';

type ActivationRow = {
  connectionId: string;
  providerAccountId: string;
  tokenRef: string;
  providerChatId: string;
  configVersion: number;
  credentialVersion: number;
  checkedConfigVersion: number | null;
  checkedCredentialVersion: number | null;
  checkedAt: Date | null;
  expiresAt: Date | null;
  status: string | null;
  connectionStatus: string;
  checks: ReadinessCheck[] | null;
};

export async function selectActivation(
  tx: PoolClient,
  workspaceId: string,
  input: { channelId: string; verificationId: string },
) {
  const result = await tx.query<ActivationRow>(
    `SELECT channel.provider_chat_id AS "providerChatId", channel.config_version AS "configVersion",
     connection.id AS "connectionId", connection.provider_account_id AS "providerAccountId",
     connection.token_secret_ref AS "tokenRef", connection.credential_version AS "credentialVersion",
     connection.status AS "connectionStatus", verification.config_version AS "checkedConfigVersion",
     verification.credential_version AS "checkedCredentialVersion", verification.checked_at AS "checkedAt",
     verification.expires_at AS "expiresAt", verification.status, verification.checks
     FROM channels AS channel JOIN bot_connections AS connection
       ON connection.id = channel.bot_connection_id AND connection.workspace_id = channel.workspace_id
     LEFT JOIN channel_verifications AS verification ON verification.id = $3 AND verification.channel_id = channel.id
       AND verification.workspace_id = channel.workspace_id AND verification.bot_connection_id = connection.id
     WHERE channel.workspace_id = $1 AND channel.id = $2 FOR UPDATE OF channel, connection`,
    [workspaceId, input.channelId, input.verificationId],
  );
  return result.rows[0];
}

export async function storeActivation(
  tx: PoolClient,
  scope: { workspaceId: string; actorId: string },
  input: {
    channelId: string;
    providerMessageId: string;
    chatType: string;
    title: string;
    now: Date;
  },
) {
  await tx.query(
    `UPDATE channels SET connection_status = 'active', monitored = true, visible_indicator_message_id = $3,
     monitoring_started_at = $4, authorization_ack_at = $4, authorization_ack_by = $5,
     provider_chat_type = $6, provider_chat_title = $7, privacy_mode_ok = true,
     verified_config_version = config_version, last_error_code = NULL
     WHERE workspace_id = $1 AND id = $2`,
    [
      scope.workspaceId,
      input.channelId,
      input.providerMessageId,
      input.now,
      scope.actorId,
      input.chatType,
      input.title,
    ],
  );
}
