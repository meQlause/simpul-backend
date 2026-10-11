import type { PoolClient } from 'pg';

type Input = { workspaceId: string; notificationId: string; opId: string; actorId: string };
type Correction = {
  threadId: string;
  displayId: string;
  personId: string | null;
  correctedAt: Date | null;
  correctionId: string | null;
  previousState: Record<string, unknown>;
  messageId: string;
};

export async function lockCorrection(tx: PoolClient, input: Input) {
  await tx.query(
    `SELECT l.id FROM labels l JOIN notifications n ON n.label_id = l.id AND n.workspace_id = $1
    JOIN threads t ON t.id = n.thread_id AND t.workspace_id = $1
    WHERE l.workspace_id = $1 AND l.op_id = $3 AND n.id = $2 FOR UPDATE OF l, t`,
    [input.workspaceId, input.notificationId, input.opId],
  );
  const result = await tx.query<Correction>(
    `SELECT n.thread_id AS "threadId", t.display_id AS "displayId", n.recipient_person_id AS "personId",
      n.corrected_at AS "correctedAt", p.previous_state AS "previousState", l.evidence_message_ids[1] AS "messageId",
      (SELECT id FROM notifications WHERE workspace_id = $1 AND label_id = n.label_id AND kind = 'correction'
        AND recipient_person_id IS NOT DISTINCT FROM n.recipient_person_id
        AND destination_channel_id IS NOT DISTINCT FROM n.destination_channel_id) AS "correctionId"
    FROM notifications n JOIN labels l ON l.id = n.label_id AND l.workspace_id = $1
    JOIN threads t ON t.id = n.thread_id AND t.workspace_id = $1
    JOIN progress_markers p ON p.op_id = l.op_id AND p.workspace_id = $1 AND p.previous_state IS NOT NULL
    JOIN people actor ON actor.id = $4 AND actor.workspace_id = $1 AND actor.active
    WHERE n.workspace_id = $1 AND n.id = $2 AND l.op_id = $3 AND n.sent_at IS NOT NULL AND n.kind <> 'correction'
    FOR UPDATE OF n`,
    [input.workspaceId, input.notificationId, input.opId, input.actorId],
  );

  return result.rows[0];
}

export async function storeCorrection(
  tx: PoolClient,
  input: Input,
  snapshot: { now: Date; previousState: Record<string, unknown> },
) {
  await tx.query(
    `INSERT INTO corrections (workspace_id, op_id, notification_id, corrected_by, correction_type, previous_state, created_at)
    VALUES ($1, $3, $2, $4, 'not_this_work', $5, $6)`,
    [
      input.workspaceId,
      input.notificationId,
      input.opId,
      input.actorId,
      snapshot.previousState,
      snapshot.now,
    ],
  );
  await tx.query(
    "UPDATE notifications SET corrected_at = $3 WHERE workspace_id = $1 AND label_id = (SELECT label_id FROM notifications WHERE workspace_id = $1 AND id = $2) AND kind <> 'correction'",
    [input.workspaceId, input.notificationId, snapshot.now],
  );
  const result = await tx.query<{ id: string }>(
    `INSERT INTO notifications (workspace_id, label_id, thread_id, recipient_person_id, destination_channel_id, kind, channel, body_rendered, held_until, created_at)
    SELECT $1, n.label_id, n.thread_id, n.recipient_person_id, n.destination_channel_id, 'correction', n.channel,
      t.display_id || ' · Correction recorded · Link removed · Prior state restored', $3, $3
    FROM notifications n JOIN threads t ON t.id = n.thread_id AND t.workspace_id = $1
    WHERE n.workspace_id = $1 AND n.id = $2 RETURNING id`,
    [input.workspaceId, input.notificationId, snapshot.now],
  );

  return result.rows[0].id;
}
