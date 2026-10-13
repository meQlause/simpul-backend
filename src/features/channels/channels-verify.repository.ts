import type { PoolClient } from 'pg';
import type { ReadinessCheck } from '../../platform/providers/index.js';

export async function selectReadiness(
  tx: PoolClient,
  workspaceId: string,
  channelId: string,
  now: Date,
) {
  const result = await tx.query<{
    connectionId: string;
    providerAccountId: string;
    tokenRef: string;
    providerChatId: string;
    configVersion: number;
    credentialVersion: number;
    channelStatus: string;
    monitored: boolean;
    inbound: boolean;
  }>(
    `SELECT channel.bot_connection_id AS "connectionId",connection.provider_account_id AS "providerAccountId",
     connection.token_secret_ref AS "tokenRef",channel.provider_chat_id AS "providerChatId",
     channel.config_version AS "configVersion",connection.credential_version AS "credentialVersion",
     channel.connection_status AS "channelStatus",channel.monitored,
     EXISTS (SELECT 1 FROM channel_connection_sessions AS session WHERE session.workspace_id = channel.workspace_id
       AND session.bot_connection_id = connection.id AND session.candidate_chat_id = channel.provider_chat_id
       AND session.purpose IN ('identify_group','receive_check') AND session.credential_version = connection.credential_version
       AND session.received_at IS NOT NULL AND session.expires_at > $3) AS inbound
     FROM channels AS channel JOIN bot_connections AS connection
       ON connection.id = channel.bot_connection_id AND connection.workspace_id = channel.workspace_id
     WHERE channel.workspace_id = $1 AND channel.id = $2 FOR UPDATE OF channel,connection`,
    [workspaceId, channelId, now],
  );

  return result.rows[0];
}

export async function storeReadiness(
  tx: PoolClient,
  workspaceId: string,
  input: {
    channelId: string;
    connectionId: string;
    configVersion: number;
    credentialVersion: number;
    channelStatus: string;
    status: string;
    check: {
      id: string;
      checks: ReadinessCheck[];
      checkedAt: Date;
      expiresAt: Date;
      activationReady: boolean;
    };
    chat: { title: string; chatType: string };
  },
) {
  const check = input.check;

  await tx.query(
    `INSERT INTO channel_verifications (id,workspace_id,channel_id,bot_connection_id,config_version,credential_version,checks,status,checked_at,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      check.id,
      workspaceId,
      input.channelId,
      input.connectionId,
      input.configVersion,
      input.credentialVersion,
      JSON.stringify(check.checks),
      input.status,
      check.checkedAt,
      check.expiresAt,
    ],
  );
  await tx.query(
    `UPDATE channels SET connection_status = $3, monitored = monitored AND $3 = 'active',
     verified_at = CASE WHEN $4 THEN $5::timestamptz ELSE NULL END, verified_config_version = CASE WHEN $4 THEN config_version ELSE NULL END,
     provider_chat_title = $6,provider_chat_type = $7, privacy_mode_ok = $8
     WHERE workspace_id = $1 AND id = $2`,
    [
      workspaceId,
      input.channelId,
      input.channelStatus,
      check.activationReady,
      check.checkedAt,
      input.chat.title,
      input.chat.chatType,
      check.checks.some((row) => row.key === 'privacy_mode' && row.status === 'pass'),
    ],
  );
}
