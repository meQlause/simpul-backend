import type { PoolClient } from 'pg';

export async function lockReminderAnswer(
  tx: PoolClient,
  input: { workspaceId: string; notificationId: string; opId: string; actorId: string },
) {
  await tx.query(
    `SELECT t.id FROM threads t JOIN notifications n ON n.thread_id = t.id AND n.workspace_id = $1
    WHERE t.workspace_id = $1 AND n.id = $2 AND n.label_id IS NULL FOR UPDATE OF t`,
    [input.workspaceId, input.notificationId],
  );
  const result = await tx.query<{
    threadId: string;
    personId: string | null;
    correctedAt: null;
    messageId: null;
  }>(
    `SELECT n.thread_id AS "threadId", n.recipient_person_id AS "personId", NULL AS "correctedAt", NULL AS "messageId"
    FROM notifications n JOIN threads t ON t.id = n.thread_id AND t.workspace_id = $1
    JOIN people actor ON actor.workspace_id = $1 AND actor.id = $4 AND actor.active
    WHERE n.workspace_id = $1 AND n.id = $2 AND n.id = $3 AND n.label_id IS NULL
      AND n.kind IN ('reminder','escalation') AND n.sent_at IS NOT NULL AND n.cancelled_at IS NULL
      AND n.stale_since = t.last_activity_at AND t.status = 'active' AND NOT t.historical
    FOR UPDATE OF n`,
    [input.workspaceId, input.notificationId, input.opId, input.actorId],
  );

  return result.rows[0];
}
