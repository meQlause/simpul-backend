import type { PoolClient } from 'pg';

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
