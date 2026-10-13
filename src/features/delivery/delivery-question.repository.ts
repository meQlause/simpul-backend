import type { PoolClient } from 'pg';

// The open question a reply or a button in this chat answers: exactly one, from this person (FR-RES-02).
export async function questionTarget(
  tx: PoolClient,
  scope: { workspaceId: string; connectionId: string; provider: string; now: Date },
  actor: { chatId: string; senderExternalId: string },
  questionId?: string,
) {
  const { rows } = await tx.query<{ questionId: string; threadIds: string[]; actorId: string }>(
    `SELECT q.id AS "questionId", q.thread_ids AS "threadIds", p.id AS "actorId"
     FROM open_questions q
     JOIN channels c ON c.workspace_id = q.workspace_id AND c.id = q.channel_id
     JOIN bot_connections b ON b.workspace_id = q.workspace_id AND b.id = c.bot_connection_id
     JOIN person_identities identity ON identity.workspace_id = $1 AND identity.provider = $3 AND identity.external_id = $5
     JOIN people p ON p.id = identity.person_id AND p.workspace_id = $1 AND p.active
     WHERE q.workspace_id = $1 AND b.id = $2 AND b.provider = $3 AND c.provider_chat_id = $4
       AND ($6::uuid IS NULL OR q.id = $6)
       AND q.answer IS NULL AND q.unit_id IS NOT NULL AND q.expires_at > $7
       AND c.monitored AND c.connection_status = 'active'
     LIMIT 2`,
    [
      scope.workspaceId,
      scope.connectionId,
      scope.provider,
      actor.chatId,
      actor.senderExternalId,
      questionId ?? null,
      scope.now,
    ],
  );

  return rows.length === 1 ? rows[0] : undefined;
}

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
