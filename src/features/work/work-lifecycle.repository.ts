import type { PoolClient } from 'pg';

export function archiveRows(tx: PoolClient, workspaceId: string, now: Date) {
  return tx.query(
    `WITH changed AS (
    UPDATE threads SET status = 'archived' WHERE workspace_id = $1 AND status IN ('completed','cancelled')
      AND closed_at <= $2::timestamptz - interval '14 days' RETURNING id, display_id)
    INSERT INTO decisions (workspace_id, kind, thread_id, title, detail, occurred_at)
    SELECT $1, 'work', id, display_id || ' archived', 'Closed for 14 days.', $2 FROM changed`,
    [workspaceId, now],
  );
}

export function reopenRows(tx: PoolClient, workspaceId: string, unitId: string, now: Date) {
  return tx.query(
    `WITH changed AS (
    UPDATE threads t SET status = 'active', closed_at = NULL, closed_by = NULL,
      closure_kind = NULL, closure_reason = NULL, last_activity_at = $3
    FROM units u WHERE t.workspace_id = $1 AND t.status = 'archived' AND u.workspace_id = $1 AND u.id = $2
      AND (t.display_id = ANY(u.explicit_ids) OR EXISTS (
        SELECT 1 FROM unit_messages member JOIN messages_raw current ON current.id = member.message_id AND current.workspace_id = $1
        JOIN messages_raw prior ON prior.channel_id = current.channel_id AND prior.provider_msg_id = current.reply_to_id AND prior.workspace_id = $1
        JOIN message_thread_link link ON link.message_id = prior.id AND link.workspace_id = $1 AND link.thread_id = t.id
        WHERE member.unit_id = u.id AND member.workspace_id = $1))
    RETURNING t.id, t.display_id)
    INSERT INTO decisions (workspace_id, kind, thread_id, title, detail, occurred_at)
    SELECT $1, 'work', id, display_id || ' reopened', 'A new message explicitly references archived work.', $3 FROM changed`,
    [workspaceId, unitId, now],
  );
}
