import { lockSender } from './ingest.coalesce.repository.js';
import type { PoolClient } from 'pg';
import type { InboundMessage } from '../../platform/providers/index.js';

type Scope = { workspaceId: string; connectionId: string };

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

  const dedup = await tx.query(
    'INSERT INTO provider_updates (workspace_id, bot_connection_id, update_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING update_id',
    [scope.workspaceId, scope.connectionId, event.updateId],
  );

  if (!dedup.rowCount) {
    return null;
  }

  const message = await tx.query(
    'INSERT INTO messages_raw (workspace_id, channel_id, provider_msg_id, sender_external_id, body, body_safe, server_ts, received_ts) VALUES ($1, $2, $3, $4, $5, $5, $6, $7) ON CONFLICT (workspace_id, channel_id, provider_msg_id) DO NOTHING RETURNING id',
    [
      scope.workspaceId,
      channel.rows[0].id,
      event.messageId,
      event.senderExternalId,
      event.body,
      new Date(event.serverTs),
      receivedAt,
    ],
  );

  return message.rowCount ? channel.rows[0].id : null;
}
