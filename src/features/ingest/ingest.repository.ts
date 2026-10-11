import { redactPii } from './ingest.rules.js';
import { lockSender } from './ingest.coalesce.repository.js';
import type { PoolClient } from 'pg';
import type { InboundMessage } from '../../platform/providers/index.js';

type Scope = { workspaceId: string; connectionId: string };

export async function claimProviderUpdate(tx: PoolClient, scope: Scope, updateId: string) {
  const dedup = await tx.query(
    'INSERT INTO provider_updates (workspace_id, bot_connection_id, update_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING update_id',
    [scope.workspaceId, scope.connectionId, updateId],
  );

  return Boolean(dedup.rowCount);
}

export async function connectionProvider(tx: PoolClient, scope: Scope) {
  const connection = await tx.query<{ provider: string }>(
    'SELECT provider FROM bot_connections WHERE workspace_id = $1 AND id = $2',
    [scope.workspaceId, scope.connectionId],
  );

  return connection.rows[0]?.provider;
}

export async function connectionTokenRef(tx: PoolClient, scope: Scope) {
  const result = await tx.query<{ tokenRef: string }>(
    'SELECT token_secret_ref AS "tokenRef" FROM bot_connections WHERE workspace_id = $1 AND id = $2',
    [scope.workspaceId, scope.connectionId],
  );

  return result.rows[0]?.tokenRef;
}

export async function isOwnBot(tx: PoolClient, scope: Scope, senderExternalId: string) {
  const bot = await tx.query(
    'SELECT id FROM bot_connections WHERE workspace_id = $1 AND id = $2 AND provider_account_id = $3',
    [scope.workspaceId, scope.connectionId, senderExternalId],
  );

  return Boolean(bot.rowCount);
}

export async function storeMessage(
  tx: PoolClient,
  scope: Scope,
  event: InboundMessage,
  receivedAt: Date,
) {
  const channel = await tx.query<{ id: string }>(
    "SELECT id FROM channels WHERE workspace_id = $1 AND bot_connection_id = $2 AND provider_chat_id = $3 AND monitored AND connection_status = 'active' FOR SHARE",
    [scope.workspaceId, scope.connectionId, event.chatId],
  );

  if (!channel.rows[0]) {
    return null;
  }

  await lockSender(tx, {
    workspaceId: scope.workspaceId,
    channelId: channel.rows[0].id,
    senderExternalId: event.senderExternalId,
  });

  if (!(await claimProviderUpdate(tx, scope, event.updateId))) {
    return null;
  }

  const message = await tx.query(
    'INSERT INTO messages_raw (workspace_id, channel_id, provider_msg_id, sender_external_id, body, body_safe, server_ts, received_ts, media_ref) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (workspace_id, channel_id, provider_msg_id) DO NOTHING RETURNING id',
    [
      scope.workspaceId,
      channel.rows[0].id,
      event.messageId,
      event.senderExternalId,
      event.body,
      redactPii(event.body),
      new Date(event.serverTs),
      receivedAt,
      event.mediaRef ?? null,
    ],
  );

  return message.rowCount ? channel.rows[0].id : null;
}

export async function storedMediaId(
  tx: PoolClient,
  scope: { workspaceId: string; channelId: string },
  providerMsgId: string,
) {
  return (
    await tx.query<{ id: string }>(
      'SELECT id FROM messages_raw WHERE workspace_id = $1 AND channel_id = $2 AND provider_msg_id = $3 AND media_ref IS NOT NULL',
      [scope.workspaceId, scope.channelId, providerMsgId],
    )
  ).rows[0]?.id;
}
