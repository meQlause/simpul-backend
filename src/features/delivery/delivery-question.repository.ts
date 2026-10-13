import type { PoolClient } from 'pg';

// A question that can still be sent: unanswered, unexpired, anchored to a unit, and its channel monitored.
export async function pendingQuestion(
  tx: PoolClient,
  scope: { workspaceId: string; questionId: string },
  now: Date,
) {
  const { rows } = await tx.query<{
    provider: string;
    connectionId: string;
    providerAccountId: string;
    tokenRef: string;
    chatId: string;
    labels: string[];
  }>(
    `SELECT b.provider, b.id AS "connectionId", b.provider_account_id AS "providerAccountId",
       b.token_secret_ref AS "tokenRef", c.provider_chat_id AS "chatId",
       ARRAY(
         SELECT concat_ws(' — ', t.customer_label, t.summary)
         FROM unnest(q.thread_ids) WITH ORDINALITY AS wanted(id, position)
         JOIN threads t ON t.workspace_id = $1 AND t.id = wanted.id
         ORDER BY wanted.position
       ) AS labels
     FROM open_questions q
     JOIN channels c ON c.workspace_id = q.workspace_id AND c.id = q.channel_id
     JOIN bot_connections b ON b.workspace_id = q.workspace_id AND b.id = c.bot_connection_id
     WHERE q.workspace_id = $1 AND q.id = $2 AND q.answer IS NULL AND q.unit_id IS NOT NULL
       AND q.expires_at > $3 AND c.monitored AND c.connection_status = 'active'`,
    [scope.workspaceId, scope.questionId, now],
  );

  return rows[0];
}
