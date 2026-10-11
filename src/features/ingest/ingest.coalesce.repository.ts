import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; channelId: string; senderExternalId: string };

export type PendingMessage = { id: string; bodySafe: string; serverTs: number; receivedTs: number };

export async function lockSender(tx: PoolClient, scope: Scope) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    scope.workspaceId + ':' + scope.channelId + ':' + scope.senderExternalId,
  ]);
}

export async function pendingMessages(tx: PoolClient, scope: Scope) {
  await lockSender(tx, scope);
  const result = await tx.query<{
    id: string;
    body_safe: string;
    server_ts: Date;
    received_ts: Date;
  }>(
    'SELECT m.id, m.body_safe, m.server_ts, m.received_ts FROM messages_raw AS m WHERE m.workspace_id = $1 AND m.channel_id = $2 AND m.sender_external_id = $3 AND NOT EXISTS (SELECT 1 FROM unit_messages WHERE message_id = m.id) ORDER BY m.server_ts, m.id',
    [scope.workspaceId, scope.channelId, scope.senderExternalId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    bodySafe: row.body_safe,
    serverTs: row.server_ts.getTime(),
    receivedTs: row.received_ts.getTime(),
  }));
}

export async function storeUnit(tx: PoolClient, scope: Scope, messages: PendingMessage[]) {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO units (workspace_id, channel_id, sender_id, text, ts_first, ts_last, explicit_ids)
    VALUES ($1, $2, (SELECT identity.person_id FROM person_identities AS identity JOIN channels AS channel ON channel.provider = identity.provider
      WHERE identity.workspace_id = $1 AND identity.external_id = $3 AND channel.id = $2), $4, $5, $6,
      ARRAY(SELECT captures[1] FROM regexp_matches($4, '\\m([A-Z][A-Z0-9]*-[0-9]+)\\M', 'g') captures)) RETURNING id`,
    [
      scope.workspaceId,
      scope.channelId,
      scope.senderExternalId,
      messages.map((message) => message.bodySafe).join(' '),
      new Date(messages[0].serverTs),
      new Date(messages[messages.length - 1].serverTs),
    ],
  );
  const id = result.rows[0].id;

  await tx.query(
    'INSERT INTO unit_messages (workspace_id, unit_id, message_id) SELECT $1, $2, unnest($3::uuid[])',
    [scope.workspaceId, id, messages.map((message) => message.id)],
  );

  return id;
}
