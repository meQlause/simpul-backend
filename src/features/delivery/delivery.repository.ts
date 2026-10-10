import type { PoolClient } from 'pg';

export async function cancelChannelUnsent(
  tx: PoolClient,
  workspaceId: string,
  input: { channelId: string; now: Date },
) {
  await tx.query(
    `UPDATE notifications AS notification SET cancelled_at = $3
    FROM labels AS label JOIN units AS unit ON unit.id = label.unit_id AND unit.workspace_id = label.workspace_id
    WHERE notification.workspace_id = $1 AND notification.label_id = label.id AND label.workspace_id = $1
      AND unit.channel_id = $2 AND notification.sent_at IS NULL AND notification.cancelled_at IS NULL`,
    [workspaceId, input.channelId, input.now],
  );
}
