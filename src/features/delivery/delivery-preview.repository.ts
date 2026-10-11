import type { PoolClient } from 'pg';

export async function selectPreviewWork(tx: PoolClient, workspaceId: string, now: Date) {
  const result = await tx.query<{
    threadId: string;
    displayId: string;
    customer: string;
    summary: string;
    channelId: string;
    channelName: string;
    roleId: string | null;
    holderName: string;
    template: string;
    reminderCount: number;
    holdSeconds: number;
    opId: string | null;
  }>(
    `SELECT t.id AS "threadId", t.display_id AS "displayId", coalesce(t.customer_label, '') AS customer, t.summary,
    c.id AS "channelId", c.display_name AS "channelName", role.id AS "roleId", coalesce(owner.name, '') AS "holderName", template.body AS template,
    policy.hold_seconds AS "holdSeconds", (SELECT count(*)::int FROM notifications WHERE workspace_id = $1 AND thread_id = t.id AND kind = 'reminder' AND sent_at IS NOT NULL) AS "reminderCount",
    (SELECT op_id FROM labels WHERE workspace_id = $1 AND thread_id = t.id AND retracted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1) AS "opId"
    FROM threads t JOIN channels c ON c.workspace_id = $1 AND c.id = t.channel_id
    JOIN policies policy ON policy.workspace_id = $1
    LEFT JOIN people owner ON owner.workspace_id = $1 AND owner.id = t.owner_person_id
    LEFT JOIN LATERAL (SELECT r.id FROM roles r JOIN role_members member ON member.workspace_id = $1 AND member.role_id = r.id
      AND member.person_id = owner.id AND member.kind = 'member' WHERE r.workspace_id = $1 AND r.active ORDER BY r.name, r.id LIMIT 1) role ON true
    JOIN templates template ON template.workspace_id = $1 AND template.audience = c.class AND template.key = 'update'
    LEFT JOIN thresholds threshold ON threshold.workspace_id = $1 AND threshold.scope = 'domain' AND threshold.scope_id = t.domain_id AND threshold.key = 'stalled_after_hours'
    WHERE t.workspace_id = $1 AND t.status = 'active' AND NOT t.historical
    ORDER BY coalesce(t.last_activity_at < $2::timestamptz - threshold.value * interval '1 hour', false) DESC, t.last_activity_at DESC, t.id DESC LIMIT 1`,
    [workspaceId, now],
  );

  return result.rows[0];
}

export async function selectPreviewCandidates(
  tx: PoolClient,
  workspaceId: string,
  channelId: string,
  now: Date,
) {
  const result = await tx.query<{ displayId: string; label: string }>(
    `SELECT t.display_id AS "displayId", concat_ws(' — ', t.customer_label, t.summary) AS label
    FROM open_questions question CROSS JOIN LATERAL unnest(question.thread_ids) WITH ORDINALITY candidate(id, position)
    JOIN threads t ON t.workspace_id = $1 AND t.id = candidate.id
    WHERE question.workspace_id = $1 AND question.channel_id = $2 AND question.answer IS NULL AND question.expires_at > $3
    ORDER BY question.asked_at DESC, question.id, candidate.position LIMIT 3`,
    [workspaceId, channelId, now],
  );

  return result.rows;
}

export async function selectPreviewDigest(tx: PoolClient, workspaceId: string) {
  const result = await tx.query<{ id: string | null; recipientName: string | null; time: string }>(
    `SELECT digest.id, person.name AS "recipientName", left(policy.digest_time::text, 5) AS time
    FROM policies policy LEFT JOIN LATERAL (SELECT * FROM digests WHERE workspace_id = $1 ORDER BY scheduled_for DESC, id DESC LIMIT 1) digest ON true
    LEFT JOIN people person ON person.workspace_id = $1 AND person.id = digest.recipient_person_id WHERE policy.workspace_id = $1`,
    [workspaceId],
  );
  const digest = result.rows[0];
  const items = await tx.query<{ body: string }>(
    `SELECT body_rendered AS body FROM notifications WHERE workspace_id = $1 AND digest_id = $2 AND cancelled_at IS NULL
    UNION ALL SELECT t.display_id || ': ' || t.summary FROM digest_items item JOIN labels label ON label.workspace_id = $1 AND label.id = item.label_id AND label.retracted_at IS NULL
    JOIN threads t ON t.workspace_id = $1 AND t.id = label.thread_id JOIN rules rule ON rule.workspace_id = $1 AND rule.id = item.rule_id AND rule.active
    WHERE item.workspace_id = $1 AND item.digest_id = $2 LIMIT 4`,
    [workspaceId, digest.id],
  );

  return {
    recipientName: digest.recipientName,
    time: digest.time,
    items: items.rows.map((item) => item.body),
  };
}
