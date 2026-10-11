import type { PoolClient } from 'pg';
import type { parseWorkQuery, parseGenesis, parseClosure, parseWorkExport } from './work.schema.js';
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

const summaryColumns = `SELECT item.id, item.display_id AS "displayId", item.customer_label AS customer, item.summary, item.status,
    domain.name AS category, item.last_activity_at AS "lastActivityAt", rhythm.value::float AS "thresholdHours",
    CASE WHEN owner.id IS NULL THEN NULL ELSE jsonb_build_object('id', owner.id, 'name', owner.name, 'team',
      (SELECT role.team FROM roles AS role JOIN role_members AS member ON member.role_id = role.id
        WHERE role.workspace_id = $1 AND member.workspace_id = $1 AND member.person_id = owner.id AND member.kind = 'member' ORDER BY role.name LIMIT 1)) END AS owner,
    jsonb_build_object('id', channel.id, 'displayName', channel.display_name) AS channel
`;

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
    `${summaryColumns}
    ${filteredWork} AND ($5::timestamptz IS NULL OR (item.last_activity_at, item.id) < ($5, $6::uuid))
    ORDER BY item.last_activity_at DESC, item.id DESC LIMIT $7`,
    [...filters, input.cursor?.at ?? null, input.cursor?.id ?? null, input.limit + 1],
  );

  return { rows: rows.rows, total: total.rows[0].total };
}

export async function insertGenesis(
  tx: PoolClient,
  workspaceId: string,
  input: ReturnType<typeof parseGenesis>,
  creation: { displayId: string; status: string; expiresAt: Date | null; now: Date },
) {
  return (
    await tx.query<{ id: string; displayId: string; status: string }>(
      'INSERT INTO threads (workspace_id, domain_id, channel_id, display_id, summary, genesis_confidence, status, expires_at, last_activity_at, created_at) SELECT $1, $2, channel.id, $4, $5, $6, $7, $8, $9, $9 FROM channels AS channel WHERE channel.workspace_id = $1 AND channel.id = $3 RETURNING id, display_id AS "displayId", status',
      [
        workspaceId,
        input.domainId,
        input.channelId,
        creation.displayId,
        input.summary,
        input.confidence,
        creation.status,
        creation.expiresAt,
        creation.now,
      ],
    )
  ).rows[0];
}

type DetailRow = WorkRow & {
  nextStep: string | null;
  createdAt: Date;
  closedAt: Date | null;
  closedBy: string | null;
  closureKind: string | null;
  closureReason: string | null;
  closedByName: string | null;
  latestUpdate: { text: string; at: string } | null;
  reminderCount: number;
  ruleApplied: string | null;
  backupName: string | null;
};

export async function selectWorkDetail(
  tx: PoolClient,
  workspaceId: string,
  displayId: string,
  now: Date,
) {
  return (
    await tx.query<DetailRow>(
      `${summaryColumns},
    item.next_step AS "nextStep", item.created_at AS "createdAt", item.closed_at AS "closedAt",
    item.closed_by AS "closedBy", item.closure_kind AS "closureKind", item.closure_reason AS "closureReason",
    (SELECT name FROM people WHERE workspace_id = $1 AND id = item.closed_by) AS "closedByName",
    (SELECT jsonb_build_object('text', text, 'at', ts) FROM progress_markers WHERE workspace_id = $1 AND thread_id = item.id ORDER BY ts DESC, id DESC LIMIT 1) AS "latestUpdate",
    (SELECT count(*)::int FROM notifications WHERE workspace_id = $1 AND thread_id = item.id AND kind = 'reminder' AND sent_at IS NOT NULL) AS "reminderCount",
    (SELECT rule.name FROM label_rule_matches AS matched JOIN labels AS label ON label.id = matched.label_id AND label.workspace_id = $1 JOIN rules AS rule ON rule.id = matched.rule_id AND rule.workspace_id = $1 WHERE matched.workspace_id = $1 AND label.thread_id = item.id ORDER BY matched.matched_at DESC, rule.id DESC LIMIT 1) AS "ruleApplied",
    (SELECT backup.name FROM role_members AS member JOIN role_members AS replacement ON replacement.role_id = member.role_id AND replacement.workspace_id = $1 AND replacement.kind = 'backup' JOIN people AS backup ON backup.id = replacement.person_id AND backup.workspace_id = $1 JOIN roles AS role ON role.id = member.role_id AND role.workspace_id = $1 WHERE member.workspace_id = $1 AND member.person_id = owner.id AND member.kind = 'member' ORDER BY role.name, backup.name LIMIT 1) AS "backupName"
    ${filteredWork} AND item.display_id = $5`,
      [workspaceId, now, null, null, displayId],
    )
  ).rows[0];
}

export async function lockWork(tx: PoolClient, workspaceId: string, displayId: string, now: Date) {
  await tx.query(
    "SELECT id FROM threads WHERE workspace_id = $1 AND display_id = $2 AND (status <> 'tentative' OR expires_at > $3) FOR UPDATE",
    [workspaceId, displayId, now],
  );

  return selectWorkDetail(tx, workspaceId, displayId, now);
}

export async function storeClosure(
  tx: PoolClient,
  scope: { workspaceId: string; actorId: string },
  itemId: string,
  input: ReturnType<typeof parseClosure> & { status: string; now: Date },
) {
  return (
    await tx.query(
      "UPDATE threads SET status = $3, closure_kind = $4, closure_reason = $5, closed_at = $6, closed_by = $7 WHERE workspace_id = $1 AND id = $2 AND status = 'active' RETURNING id",
      [
        scope.workspaceId,
        itemId,
        input.status,
        input.closure,
        input.reason,
        input.now,
        scope.actorId,
      ],
    )
  ).rowCount;
}

export async function clearClosure(tx: PoolClient, workspaceId: string, itemId: string) {
  return (
    await tx.query(
      "UPDATE threads SET status = 'active', closure_kind = NULL, closure_reason = NULL, closed_at = NULL, closed_by = NULL WHERE workspace_id = $1 AND id = $2 AND status IN ('completed', 'cancelled') AND closed_by IS NOT NULL AND last_activity_at <= closed_at RETURNING id",
      [workspaceId, itemId],
    )
  ).rowCount;
}

export async function openWorkExport(
  tx: PoolClient,
  workspaceId: string,
  input: ReturnType<typeof parseWorkExport>,
  now: Date,
) {
  await tx.query(
    `DECLARE work_export NO SCROLL CURSOR FOR ${summaryColumns} ${filteredWork} ORDER BY item.last_activity_at DESC, item.id DESC`,
    [workspaceId, now, input.status ?? null, input.q ?? null],
  );
}

export async function fetchWorkExport(tx: PoolClient) {
  const result = await tx.query<WorkRow>('FETCH FORWARD 100 FROM work_export');

  if (result.rows.length === 0) {
    await tx.query('CLOSE work_export');
  }

  return result.rows;
}

export async function deleteExpiredTentative(tx: PoolClient, workspaceId: string, now: Date) {
  return (
    (
      await tx.query(
        "DELETE FROM threads WHERE workspace_id = $1 AND status = 'tentative' AND expires_at <= $2",
        [workspaceId, now],
      )
    ).rowCount ?? 0
  );
}
