import type { PoolClient } from 'pg';
import type { parseRuleEstimate } from './rules-write.schema.js';

export async function ruleRows(tx: PoolClient, workspaceId: string, now: Date) {
  const { rows } = await tx.query<{ data: Record<string, unknown> }>(
    `SELECT jsonb_build_object(
      'id', r.id, 'name', r.name,
      'category', jsonb_build_object('id', d.id, 'name', d.name),
      'eventType', r.event_type, 'conditionText', r.condition_text,
      'recipient', jsonb_build_object('roleId', role.id, 'team', role.team, 'holderName', person.name),
      'historyMode', r.history_mode, 'active', r.active,
      'matches30d', matches.total, 'corrections30d', corrections.total,
      'correctionRate', round(corrections.total * 100.0 / greatest(1, matches.total))::text,
      'weeklyEstimate', round(matches.total / 30.0 * 7)::int
    ) AS data
    FROM rules r
    JOIN vocab_domains d ON d.id = r.domain_id AND d.workspace_id = $1
    JOIN roles role ON role.id = r.recipient_role_id AND role.workspace_id = $1
    LEFT JOIN role_members member ON member.role_id = role.id AND member.kind = 'member' AND member.workspace_id = $1
    LEFT JOIN people person ON person.id = member.person_id AND person.workspace_id = $1
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS total FROM label_rule_matches m
      WHERE m.workspace_id = $1 AND m.rule_id = r.id
        AND m.matched_at >= $2::timestamptz - interval '30 days' AND m.matched_at <= $2
    ) matches
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS total FROM corrections c
      JOIN notifications n ON n.id = c.notification_id AND n.workspace_id = $1
      WHERE c.workspace_id = $1 AND n.rule_id = r.id
        AND c.created_at >= $2::timestamptz - interval '30 days' AND c.created_at <= $2
    ) corrections
    WHERE r.workspace_id = $1 ORDER BY r.created_at, r.id`,
    [workspaceId, now],
  );

  return rows.map((row) => row.data);
}

export async function ruleEstimate(
  tx: PoolClient,
  workspaceId: string,
  input: ReturnType<typeof parseRuleEstimate>,
  now: Date,
) {
  const result = await tx.query<{ data: Record<string, unknown> }>(
    `WITH hourly AS (
      SELECT date_trunc('hour', l.created_at AT TIME ZONE w.timezone) AS hour, count(*)::int AS total
      FROM labels l JOIN workspaces w ON w.id = l.workspace_id
      LEFT JOIN threads t ON t.workspace_id = $1 AND t.id = l.thread_id
      WHERE l.workspace_id = $1 AND coalesce(l.domain_id, t.domain_id) = $2 AND l.retracted_at IS NULL
        AND (CASE WHEN EXISTS (SELECT 1 FROM message_thread_link link
          WHERE link.workspace_id = $1 AND link.thread_id = l.thread_id AND link.role = 'genesis'
            AND link.message_id = ANY(l.evidence_message_ids)) THEN 'new' ELSE l.type END) = $3
        AND l.created_at >= $5::timestamptz - interval '30 days' AND l.created_at <= $5
      GROUP BY hour
    ), volume AS (
      SELECT coalesce(sum(total), 0)::int AS matches, coalesce(max(total), 0)::int AS peak FROM hourly
    )
    SELECT jsonb_build_object('matches30d', volume.matches, 'peakPerHour', volume.peak,
      'budgetPerHour', policy.budget_per_hour, 'exceedsBudget', volume.peak > policy.budget_per_hour,
      'recipient', jsonb_build_object('holderName', person.name)) AS data
    FROM vocab_domains domain JOIN roles role ON role.workspace_id = $1 AND role.id = $4 AND role.active
    JOIN policies policy ON policy.workspace_id = $1 CROSS JOIN volume
    LEFT JOIN role_members member ON member.workspace_id = $1 AND member.role_id = role.id AND member.kind = 'member'
    LEFT JOIN people person ON person.workspace_id = $1 AND person.id = member.person_id AND person.active
    WHERE domain.workspace_id = $1 AND domain.id = $2 AND domain.active`,
    [workspaceId, input.categoryId, input.eventType, input.recipientRoleId, now],
  );

  return result.rows[0]?.data;
}
