import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; messageId: string };

export async function lockMedia(tx: PoolClient, scope: Scope) {
  await tx.query('SELECT id FROM messages_raw WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
    scope.workspaceId,
    scope.messageId,
  ]);

  return (
    await tx.query<{
      mediaRef: string;
      channelId: string;
      provider: string;
      chatId: string;
      connectionId: string;
      providerAccountId: string;
      tokenRef: string;
    }>(
      `SELECT m.media_ref AS "mediaRef", c.id AS "channelId", c.provider, c.provider_chat_id AS "chatId",
      b.id AS "connectionId", b.provider_account_id AS "providerAccountId", b.token_secret_ref AS "tokenRef"
    FROM messages_raw m JOIN channels c ON c.id = m.channel_id AND c.workspace_id = $1
    JOIN bot_connections b ON b.id = c.bot_connection_id AND b.workspace_id = $1
    WHERE m.workspace_id = $1 AND m.id = $2 AND m.media_ref IS NOT NULL AND m.origin = 'user'
      AND c.monitored AND c.connection_status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_outcomes WHERE workspace_id = $1 AND message_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM unit_messages member JOIN units u ON u.id = member.unit_id AND u.source = 'transcript' WHERE member.message_id = m.id)`,
      [scope.workspaceId, scope.messageId],
    )
  ).rows[0];
}

export async function storeTranscript(tx: PoolClient, scope: Scope, text: string) {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO units (workspace_id, channel_id, sender_id, text, source, confidence_multiplier, ts_first, ts_last, explicit_ids)
    SELECT $1, m.channel_id, (SELECT i.person_id FROM person_identities i JOIN channels c ON c.id = m.channel_id
      WHERE i.workspace_id = $1 AND i.provider = c.provider AND i.external_id = m.sender_external_id),
      $3, 'transcript', 0.85, m.server_ts, m.server_ts,
      ARRAY(SELECT captures[1] FROM regexp_matches($3, '\\m([A-Z][A-Z0-9]*-[0-9]+)\\M', 'g') captures)
    FROM messages_raw m WHERE m.workspace_id = $1 AND m.id = $2 RETURNING id`,
    [scope.workspaceId, scope.messageId, text],
  );
  const unitId = result.rows[0].id;

  await tx.query(
    'INSERT INTO unit_messages (workspace_id, unit_id, message_id) VALUES ($1, $2, $3)',
    [scope.workspaceId, unitId, scope.messageId],
  );

  return unitId;
}

export async function recordMediaOutcome(
  tx: PoolClient,
  scope: Scope,
  outcome: 'transcript' | 'unread',
) {
  await tx.query(
    'INSERT INTO media_outcomes (workspace_id, message_id, outcome) VALUES ($1, $2, $3)',
    [scope.workspaceId, scope.messageId, outcome],
  );
}
