import type { PoolClient } from 'pg';
import type { parseWorkQuery } from './work.schema.js';
import type { displayStatus } from './work.rules.js';

type WorkRow = {
  id: string;
  displayId: string;
  customer: string | null;
  summary: string;
  status: Parameters<typeof displayStatus>[0]['status'];
  category: string;
  owner: { id: string; name: string; team: string | null } | null;
  channel: { id: string; displayName: string };
  lastActivityAt: Date;
  thresholdHours: number | null;
};

const filteredWork = `FROM threads AS item
  JOIN vocab_domains AS domain ON domain.id = item.domain_id AND domain.workspace_id = $1
  JOIN channels AS channel ON channel.id = item.channel_id AND channel.workspace_id = $1
  LEFT JOIN people AS owner ON owner.id = item.owner_person_id AND owner.workspace_id = $1
  LEFT JOIN thresholds AS rhythm ON rhythm.workspace_id = $1 AND rhythm.scope = 'domain'
    AND rhythm.scope_id = item.domain_id AND rhythm.key = 'stalled_after_hours'
  WHERE item.workspace_id = $1 AND (item.status <> 'tentative' OR item.expires_at > $2)
  AND ($3::text IS NULL OR CASE WHEN item.status = 'active' AND item.last_activity_at < $2::timestamptz - rhythm.value * interval '1 hour' THEN 'stalled' ELSE item.status END = $3)
  AND ($4::text IS NULL OR strpos(lower(concat_ws(' ', item.display_id, item.customer_label, item.summary, owner.name, channel.display_name)), lower($4)) > 0)`;

export async function selectWork(
  tx: PoolClient,
  workspaceId: string,
  input: ReturnType<typeof parseWorkQuery>,
  now: Date,
) {
  const filters = [workspaceId, now, input.status ?? null, input.q ?? null];
  const total = await tx.query<{ total: number }>(
    'SELECT count(*)::int AS total ' + filteredWork,
    filters,
  );
  const rows = await tx.query<WorkRow>(
    `SELECT item.id, item.display_id AS "displayId", item.customer_label AS customer, item.summary, item.status,
    domain.name AS category, item.last_activity_at AS "lastActivityAt", rhythm.value::float AS "thresholdHours",
    CASE WHEN owner.id IS NULL THEN NULL ELSE jsonb_build_object('id', owner.id, 'name', owner.name, 'team',
      (SELECT role.team FROM roles AS role JOIN role_members AS member ON member.role_id = role.id
        WHERE role.workspace_id = $1 AND member.workspace_id = $1 AND member.person_id = owner.id AND member.kind = 'member' ORDER BY role.name LIMIT 1)) END AS owner,
    jsonb_build_object('id', channel.id, 'displayName', channel.display_name) AS channel
    ${filteredWork} AND ($5::timestamptz IS NULL OR (item.last_activity_at, item.id) < ($5, $6::uuid))
    ORDER BY item.last_activity_at DESC, item.id DESC LIMIT $7`,
    [...filters, input.cursor?.at ?? null, input.cursor?.id ?? null, input.limit + 1],
  );

  return { rows: rows.rows, total: total.rows[0].total };
}
