import type { PoolClient } from 'pg';

export type WorkCandidate = {
  id: string;
  displayId: string;
  customer: string | null;
  summary: string;
  nextStep: string | null;
  channelId: string;
  lastActivityAt: Date;
  items: { quantity?: number; qty?: number }[];
  participant: boolean;
  reply: boolean;
  evidenceCount: number;
  semantic: number;
};

export async function selectCandidates(
  tx: PoolClient,
  workspaceId: string,
  source: {
    channelId: string;
    unitId: string;
    senderId: string | null;
    explicitIds: string[];
    replyIds: string[];
  },
  now: Date,
) {
  const result = await tx.query<WorkCandidate>(
    `SELECT t.id, t.display_id AS "displayId", t.customer_label AS customer, t.summary, t.next_step AS "nextStep",
      t.channel_id AS "channelId", t.last_activity_at AS "lastActivityAt", t.items,
      coalesce(t.owner_person_id = $3, false) OR EXISTS (SELECT 1 FROM message_thread_link link
        JOIN messages_raw m ON m.id = link.message_id AND m.workspace_id = $1
        JOIN units u ON u.id = $5 AND u.workspace_id = $1
        JOIN unit_messages um ON um.unit_id = u.id AND um.workspace_id = $1
        JOIN messages_raw current ON current.id = um.message_id AND current.workspace_id = $1
        WHERE link.workspace_id = $1 AND link.thread_id = t.id AND m.sender_external_id = current.sender_external_id AND m.channel_id = current.channel_id) AS participant,
      EXISTS (SELECT 1 FROM message_thread_link link JOIN messages_raw m ON m.id = link.message_id AND m.workspace_id = $1
        WHERE link.workspace_id = $1 AND link.thread_id = t.id AND m.channel_id = $2 AND m.provider_msg_id = ANY($6)) AS reply,
      (SELECT count(*)::int FROM message_thread_link link WHERE link.workspace_id = $1 AND link.thread_id = t.id) AS "evidenceCount",
      coalesce((SELECT max(greatest(0, 1 - (current.embedding <=> prior.embedding))) FROM unit_embeddings current
        JOIN unit_embeddings prior ON prior.workspace_id = $1 JOIN unit_messages um ON um.unit_id = prior.unit_id AND um.workspace_id = $1
        JOIN message_thread_link link ON link.message_id = um.message_id AND link.workspace_id = $1
        WHERE current.workspace_id = $1 AND current.unit_id = $5 AND link.thread_id = t.id), 0)::float8 AS semantic
    FROM threads t WHERE t.workspace_id = $1 AND (
      (t.status IN ('active','tentative') AND (t.expires_at IS NULL OR t.expires_at > $4) AND
        (t.channel_id = $2 OR t.last_activity_at >= $4::timestamptz - interval '72 hours')) OR t.display_id = ANY($7))
    ORDER BY t.last_activity_at DESC, t.id LIMIT 100`,
    [
      workspaceId,
      source.channelId,
      source.senderId,
      now,
      source.unitId,
      source.replyIds,
      source.explicitIds,
    ],
  );

  return result.rows;
}
