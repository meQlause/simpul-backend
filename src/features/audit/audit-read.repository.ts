import type { PoolClient } from 'pg';
import type { parseDecisionQuery } from './audit-read.schema.js';

type DecisionRow = {
  id: string;
  kind: string;
  title: string;
  detail: string;
  occurredAt: Date;
  recipient: { id: string; name: string } | null;
};
const source = `FROM decisions d LEFT JOIN people p ON p.id = d.recipient_person_id AND p.workspace_id = $1 WHERE d.workspace_id = $1`;
const columns = `SELECT d.id, d.kind, d.title, d.detail, d.occurred_at AS "occurredAt",
  CASE WHEN p.id IS NOT NULL THEN jsonb_build_object('id', p.id, 'name', p.name) END AS recipient`;

export async function decisionCounts(tx: PoolClient, workspaceId: string) {
  const result = await tx.query<{ routing: number; work: number; queue: number; digest: number }>(
    `SELECT count(*) FILTER (WHERE kind = 'routing')::int AS routing,
    count(*) FILTER (WHERE kind = 'work')::int AS work,
    count(*) FILTER (WHERE kind = 'queue')::int AS queue,
    count(*) FILTER (WHERE kind = 'digest')::int AS digest FROM decisions WHERE workspace_id = $1`,
    [workspaceId],
  );

  return result.rows[0];
}

export async function selectDecisions(
  tx: PoolClient,
  workspaceId: string,
  input: ReturnType<typeof parseDecisionQuery>,
) {
  const filtered = `${source} AND ($2::text IS NULL OR d.kind = $2)
    AND ($3::text IS NULL OR strpos(lower(concat_ws(' ', d.title, d.detail, p.name)), lower($3)) > 0)`;
  const filters = [workspaceId, input.kind ?? null, input.q || null];
  const total = await tx.query<{ total: number }>(
    'SELECT count(*)::int AS total ' + filtered,
    filters,
  );
  const result = await tx.query<DecisionRow>(
    `${columns} ${filtered}
    AND ($4::timestamptz IS NULL OR (d.occurred_at, d.id) < ($4, $5::uuid))
    ORDER BY d.occurred_at DESC, d.id DESC LIMIT $6`,
    [...filters, input.cursor?.at ?? null, input.cursor?.id ?? null, input.limit + 1],
  );

  return { rows: result.rows, total: total.rows[0].total };
}

export async function selectDecision(tx: PoolClient, workspaceId: string, id: string) {
  const result = await tx.query<{ data: Record<string, unknown> }>(
    `WITH neighbours AS (
      SELECT id, lag(id) OVER ordering AS previous_id, lead(id) OVER ordering AS next_id,
      row_number() OVER ordering AS position, count(*) OVER () AS total
      FROM decisions WHERE workspace_id = $1 WINDOW ordering AS (ORDER BY occurred_at DESC, id DESC)
    ) SELECT jsonb_build_object('id', d.id, 'kind', d.kind, 'title', d.title, 'occurredAt', d.occurred_at,
      'work', CASE WHEN t.id IS NOT NULL THEN jsonb_build_object('displayId', t.display_id, 'customer', t.customer_label,
        'summary', t.summary, 'channelName', c.display_name) END,
      'rule', CASE WHEN d.kind = 'routing' AND r.id IS NOT NULL THEN jsonb_build_object('id', r.id, 'name', r.name,
        'conditionText', r.condition_text, 'category', domain.name, 'recipientLabel', concat_ws(' · ', holder.name, role.team), 'active', r.active) END,
      'recipient', CASE WHEN p.id IS NOT NULL THEN jsonb_build_object('id', p.id, 'name', p.name,
        'roleName', role.name, 'selection', CASE WHEN d.kind = 'digest' THEN 'digest' ELSE 'role' END, 'backupName', backup.name) END,
      'neighbours', jsonb_build_object('previousId', neighbours.previous_id, 'nextId', neighbours.next_id,
        'position', neighbours.position, 'total', neighbours.total)) AS data
    FROM decisions d JOIN neighbours ON neighbours.id = d.id
    LEFT JOIN threads t ON t.id = d.thread_id AND t.workspace_id = $1
    LEFT JOIN channels c ON c.id = t.channel_id AND c.workspace_id = $1
    LEFT JOIN rules r ON r.id = d.rule_id AND r.workspace_id = $1
    LEFT JOIN vocab_domains domain ON domain.id = r.domain_id AND domain.workspace_id = $1
    LEFT JOIN roles role ON role.id = r.recipient_role_id AND role.workspace_id = $1
    LEFT JOIN role_members member ON member.role_id = role.id AND member.workspace_id = $1 AND member.kind = 'member'
    LEFT JOIN people holder ON holder.id = member.person_id AND holder.workspace_id = $1
    LEFT JOIN role_members backup_member ON backup_member.role_id = role.id AND backup_member.workspace_id = $1 AND backup_member.kind = 'backup'
    LEFT JOIN people backup ON backup.id = backup_member.person_id AND backup.workspace_id = $1
    LEFT JOIN people p ON p.id = d.recipient_person_id AND p.workspace_id = $1
    WHERE d.workspace_id = $1 AND d.id = $2`,
    [workspaceId, id],
  );

  return result.rows[0]?.data;
}
