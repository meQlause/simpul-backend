import type { PoolClient } from 'pg';

const expired =
  "SELECT id FROM messages_raw WHERE workspace_id = $1 AND server_ts < $2::timestamptz - interval '90 days'";

export async function deleteOldMessages(tx: PoolClient, workspaceId: string, now: Date) {
  await tx.query(`${expired} FOR UPDATE`, [workspaceId, now]);
  await tx.query(
    `DELETE FROM unit_messages WHERE workspace_id = $1 AND message_id IN (${expired})`,
    [workspaceId, now],
  );
  await tx.query(
    `DELETE FROM message_thread_link WHERE workspace_id = $1 AND message_id IN (${expired})`,
    [workspaceId, now],
  );
  const result = await tx.query(
    `DELETE FROM messages_raw WHERE workspace_id = $1 AND id IN (${expired})`,
    [workspaceId, now],
  );

  return result.rowCount;
}
