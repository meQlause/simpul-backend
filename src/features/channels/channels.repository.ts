import type { ReadinessCheck } from '../../platform/providers/index.js';
import type { PoolClient } from 'pg';
import { DomainError } from '../../platform/errors/domain-error.js';
import type { parseChannel } from './channels.schema.js';

export async function selectChannelState(tx: PoolClient, workspaceId: string, channelId: string) {
  const result = await tx.query<{
    id: string;
    configVersion: number;
    connectionStatus: string;
    monitored: boolean;
  }>(
    `SELECT id, config_version AS "configVersion", connection_status AS "connectionStatus", monitored
     FROM channels WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [workspaceId, channelId],
  );

  return result.rows[0];
}

export async function storePause(tx: PoolClient, workspaceId: string, channelId: string) {
  await tx.query(
    "UPDATE channels SET monitored = false, connection_status = 'paused', config_version = config_version + 1 WHERE workspace_id = $1 AND id = $2",
    [workspaceId, channelId],
  );
}

export async function setConnectionNeedsAction(
  tx: PoolClient,
  workspaceId: string,
  connectionId: string,
) {
  const result = await tx.query<{ id: string; monitored: boolean; connectionStatus: string }>(
    `WITH previous AS MATERIALIZED (SELECT id, monitored, connection_status FROM channels WHERE workspace_id = $1 AND bot_connection_id = $2 FOR UPDATE)
     UPDATE channels AS channel SET monitored = false, connection_status = 'needs_action' FROM previous
     WHERE channel.id = previous.id AND channel.workspace_id = $1
     RETURNING channel.id, previous.monitored, previous.connection_status AS "connectionStatus"`,
    [workspaceId, connectionId],
  );

  return result.rows;
}

export async function selectChannels(tx: PoolClient, workspaceId: string) {
  const result = await tx.query(
    `SELECT channel.id, channel.display_name AS "displayName", channel.provider_chat_id AS "providerChatId",
     channel.provider_chat_type AS "providerChatType", channel.provider_chat_title AS "providerChatTitle",
     channel.member_count AS "memberCount", channel.class, channel.primary_language AS "primaryLanguage",
     channel.connection_status AS "connectionStatus", (channel.monitored AND connection.status = 'ready') AS monitored,
     CASE WHEN verification.id IS NULL THEN NULL ELSE jsonb_build_object('status', verification.status,
       'checkedAt', to_char(verification.checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END AS "lastVerification",
     channel.monitoring_started_at AS "monitoringStartedAt", channel.config_version AS "configVersion"
     FROM channels AS channel JOIN bot_connections AS connection
       ON connection.id = channel.bot_connection_id AND connection.workspace_id = channel.workspace_id
     LEFT JOIN LATERAL (SELECT id, status, checked_at FROM channel_verifications
       WHERE workspace_id = $1 AND channel_id = channel.id ORDER BY checked_at DESC, created_at DESC, id DESC LIMIT 1) AS verification ON true
     WHERE channel.workspace_id = $1 ORDER BY channel.display_name, channel.id`,
    [workspaceId],
  );

  return result.rows;
}

export async function insertDraft(
  tx: PoolClient,
  workspaceId: string,
  id: string,
  input: ReturnType<typeof parseChannel> & {
    providerChatId: string;
    providerChatTitle: string | null;
    providerChatType: string | null;
  },
) {
  try {
    const result = await tx.query<{ id: string }>(
      `INSERT INTO channels
       (id, workspace_id, provider, bot_connection_id, provider_chat_id, display_name, class, primary_language, provider_chat_title, provider_chat_type)
       SELECT $3, $1, connection.provider, connection.id, $4, $5, $6, $7, $8, $9
       FROM bot_connections AS connection WHERE connection.workspace_id = $1 AND connection.id = $2
       RETURNING id`,
      [
        workspaceId,
        input.botConnectionId,
        id,
        input.providerChatId,
        input.displayName,
        input.class,
        input.primaryLanguage,
        input.providerChatTitle,
        input.providerChatType,
      ],
    );

    return result.rows[0];
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === '23505' &&
      'constraint' in error &&
      error.constraint === 'channels_chat_uq'
    ) {
      throw new DomainError('E-TG-CHANNEL-DUPLICATE');
    }

    throw error;
  }
}

export async function selectLatestVerification(
  tx: PoolClient,
  workspaceId: string,
  channelId: string,
) {
  const result = await tx.query<{
    id: string;
    checkedAt: Date;
    expiresAt: Date;
    checks: ReadinessCheck[];
    versionsMatch: boolean;
  }>(
    `SELECT verification.id, verification.checked_at AS "checkedAt", verification.expires_at AS "expiresAt",
     verification.checks, (verification.status = 'pass' AND verification.config_version = channel.config_version
       AND verification.credential_version = connection.credential_version) AS "versionsMatch"
     FROM channel_verifications AS verification JOIN channels AS channel
       ON channel.id = verification.channel_id AND channel.workspace_id = verification.workspace_id
     JOIN bot_connections AS connection ON connection.id = channel.bot_connection_id
       AND connection.workspace_id = channel.workspace_id
     WHERE channel.workspace_id = $1 AND channel.id = $2
     ORDER BY verification.checked_at DESC, verification.created_at DESC, verification.id DESC LIMIT 1`,
    [workspaceId, channelId],
  );

  return result.rows[0];
}
