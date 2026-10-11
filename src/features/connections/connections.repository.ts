import type { PoolClient } from 'pg';
import { DomainError } from '../../platform/errors/domain-error.js';
import type { SetupProvider } from '../../platform/providers/index.js';

export async function storedAccount(tx: PoolClient, workspaceId: string) {
  const result = await tx.query<{ provider_account_id: string }>(
    "SELECT provider_account_id FROM bot_connections WHERE workspace_id = $1 AND provider = 'telegram'",
    [workspaceId],
  );

  return result.rows[0]?.provider_account_id;
}

export async function selectConnections(tx: PoolClient, workspaceId: string) {
  const result = await tx.query(
    `SELECT connection.id, connection.provider, connection.connection_name AS "connectionName",
     connection.bot_username AS "botUsername", connection.bot_name AS "botName", connection.status,
     (connection.token_secret_ref IS NOT NULL) AS "credentialsPresent", connection.credential_version AS "credentialVersion",
     connection.verified_at AS "verifiedAt", connection.webhook_checked_at AS "webhookCheckedAt",
     COALESCE((SELECT jsonb_agg(jsonb_build_object('channelId', channel.id, 'displayName', channel.display_name,
       'providerChatId', channel.provider_chat_id, 'connectionStatus', channel.connection_status) ORDER BY channel.display_name, channel.id)
       FROM channels AS channel WHERE channel.workspace_id = $1 AND channel.bot_connection_id = connection.id), '[]'::jsonb) AS groups
     FROM bot_connections AS connection WHERE connection.workspace_id = $1 AND connection.provider = 'telegram' ORDER BY connection.id`,
    [workspaceId],
  );

  return result.rows;
}

export async function insertConnection(
  tx: PoolClient,
  scope: { workspaceId: string; actorId: string },
  input: {
    id: string;
    connectionName: string;
    tokenRef: string;
    webhookRef: string;
    verifiedAt: Date;
    account: Awaited<ReturnType<SetupProvider['verifyCredential']>>;
  },
) {
  const { id, connectionName, tokenRef, webhookRef, verifiedAt, account } = input;

  try {
    await tx.query(
      `INSERT INTO bot_connections
      (id, workspace_id, provider, connection_name, provider_account_id, bot_username, bot_name,
       token_secret_ref, webhook_secret_ref, status, verified_at, webhook_checked_at, created_by)
      VALUES ($1, $2, 'telegram', $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)`,
      [
        id,
        scope.workspaceId,
        connectionName,
        account.providerAccountId,
        account.botUsername,
        account.botName,
        tokenRef,
        webhookRef,
        account.privacyModeOk ? 'ready' : 'needs_action',
        verifiedAt,
        scope.actorId,
      ],
    );
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === '23505' &&
      'constraint' in error &&
      ['bot_account_uq', 'bot_ws_provider_uq'].includes(String(error.constraint))
    ) {
      throw new DomainError('E-TG-BOT-IN-USE');
    }

    throw error;
  }
}
