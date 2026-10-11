import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; labelId: string };
type RoutingLabel = {
  id: string;
  threadId: string;
  domainId: string;
  channelId: string;
  type: string;
  tense: string;
  evidenceMessageIds: string[];
  confidence: number;
  status: string;
  historical: boolean;
  displayId: string;
  customer: string;
  summary: string;
  template: string;
  holdSeconds: number;
};

export async function lockRoutingLabel(tx: PoolClient, scope: Scope) {
  const result = await tx.query<RoutingLabel>(
    `SELECT l.id, t.id AS "threadId", coalesce(l.domain_id, t.domain_id) AS "domainId",
      u.channel_id AS "channelId", CASE WHEN EXISTS (
        SELECT 1 FROM message_thread_link link WHERE link.workspace_id = $1 AND link.thread_id = t.id
          AND link.role = 'genesis' AND link.message_id = ANY(l.evidence_message_ids)
      ) THEN 'new' ELSE l.type END AS type,
      l.tense, l.evidence_message_ids AS "evidenceMessageIds", l.confidence::float8 AS confidence,
      t.status, t.historical, t.display_id AS "displayId", coalesce(t.customer_label, '') AS customer,
      coalesce(t.summary, '') AS summary, template.body AS template, policy.hold_seconds AS "holdSeconds"
    FROM labels l JOIN threads t ON t.id = l.thread_id AND t.workspace_id = $1
    JOIN units u ON u.id = l.unit_id AND u.workspace_id = $1
    JOIN channels c ON c.id = u.channel_id AND c.workspace_id = $1
    JOIN policies policy ON policy.workspace_id = $1
    JOIN templates template ON template.workspace_id = $1 AND template.audience = c.class AND template.key = 'update'
    WHERE l.workspace_id = $1 AND l.id = $2 AND l.routed_at IS NULL AND l.retracted_at IS NULL FOR UPDATE OF l`,
    [scope.workspaceId, scope.labelId],
  );

  return result.rows[0];
}

export async function matchingRules(tx: PoolClient, workspaceId: string, label: RoutingLabel) {
  const { rows } = await tx.query<{
    ruleId: string;
    roleId: string;
    urgency: string;
    priority: number;
  }>(
    `SELECT id AS "ruleId", recipient_role_id AS "roleId", urgency, priority
    FROM rules WHERE workspace_id = $1 AND active AND domain_id = $2 AND event_type = $3
    ORDER BY priority DESC, id`,
    [workspaceId, label.domainId, label.type],
  );

  return rows;
}

export async function recordMatches(tx: PoolClient, scope: Scope, ruleIds: string[], now: Date) {
  await tx.query(
    `INSERT INTO label_rule_matches (workspace_id, label_id, rule_id, matched_at, created_at)
    SELECT $1, $2, rule, $4, $4 FROM unnest($3::uuid[]) rule ON CONFLICT DO NOTHING`,
    [scope.workspaceId, scope.labelId, ruleIds, now],
  );
}

export async function prepareNotification(
  tx: PoolClient,
  scope: Scope,
  {
    label,
    recipient,
    body,
    digestId,
  }: {
    label: RoutingLabel;
    recipient: { ruleId: string; personId: string | null; destinationChannelId: string | null };
    body: string;
    digestId: string | null;
  },
  now: Date,
) {
  await tx.query(
    `INSERT INTO notifications (workspace_id, label_id, thread_id, rule_id, recipient_person_id,
      channel, body_rendered, held_until, created_at, digest_id, destination_channel_id)
    VALUES ($1, $2, $3, $4, $5, 'telegram', $6, $7::timestamptz + $8 * interval '1 second', $7, $9, $10)
    ON CONFLICT DO NOTHING`,
    [
      scope.workspaceId,
      scope.labelId,
      label.threadId,
      recipient.ruleId,
      recipient.personId,
      body,
      now,
      label.holdSeconds,
      digestId,
      recipient.destinationChannelId,
    ],
  );
}

export async function markRouted(tx: PoolClient, scope: Scope, now: Date) {
  await tx.query('UPDATE labels SET routed_at = $3 WHERE workspace_id = $1 AND id = $2', [
    scope.workspaceId,
    scope.labelId,
    now,
  ]);
}
