import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; connectionId: string; provider: string };
type Actor = { chatId: string; senderExternalId: string };

export async function recipientActionTarget(
  tx: PoolClient,
  scope: Scope,
  actor: Actor,
  target: { displayId?: string; notificationId?: string },
) {
  const result = await tx.query<{
    notificationId: string;
    opId: string;
    actorId: string;
    hasOperation: boolean;
  }>(
    `SELECT n.id AS "notificationId", coalesce(l.op_id, n.id) AS "opId", p.id AS "actorId", n.label_id IS NOT NULL AS "hasOperation"
    FROM notifications n LEFT JOIN labels l ON l.id = n.label_id AND l.workspace_id = $1
    JOIN threads t ON t.id = n.thread_id AND t.workspace_id = $1
    JOIN channels origin ON origin.id = t.channel_id AND origin.workspace_id = $1
    JOIN person_identities identity ON identity.workspace_id = $1 AND identity.provider = $3 AND identity.external_id = $4
    JOIN people p ON p.id = identity.person_id AND p.workspace_id = $1 AND p.active
    LEFT JOIN channels destination ON destination.id = n.destination_channel_id AND destination.workspace_id = $1
    WHERE n.workspace_id = $1 AND origin.bot_connection_id = $2 AND n.channel = $3
      AND n.sent_at IS NOT NULL AND n.kind <> 'correction'
      AND ($6::text IS NULL OR t.display_id = $6) AND ($7::uuid IS NULL OR n.id = $7)
      AND ((n.recipient_person_id = p.id AND $5 = identity.external_id)
        OR (n.destination_channel_id IS NOT NULL AND destination.provider_chat_id = $5))
      AND ((n.label_id IS NULL AND n.kind IN ('reminder','escalation') AND n.stale_since = t.last_activity_at AND t.status = 'active' AND NOT t.historical)
        OR EXISTS (SELECT 1 FROM progress_markers marker WHERE marker.workspace_id = $1 AND marker.op_id = l.op_id AND marker.previous_state IS NOT NULL))
    ORDER BY n.sent_at DESC LIMIT 2`,
    [
      scope.workspaceId,
      scope.connectionId,
      scope.provider,
      actor.senderExternalId,
      actor.chatId,
      target.displayId ?? null,
      target.notificationId ?? null,
    ],
  );

  return result.rows.length === 1 ? result.rows[0] : undefined;
}
