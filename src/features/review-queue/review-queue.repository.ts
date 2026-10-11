import type { PoolClient } from 'pg';
import type { parseReviewQuery } from './review-queue.schema.js';

export type ReviewRow = {
  id: string;
  kind: 'unrouted' | 'alias' | 'category';
  title: string;
  detail: string;
  channel: { id: string; displayName: string };
  detectedAt: Date;
  labelId: string | null;
  detected: {
    text: string | null;
    suggestedPersonId: string | null;
    suggestedCategoryId: string | null;
  };
};

const source = `FROM review_items item JOIN channels c ON c.id = item.channel_id AND c.workspace_id = $1
  WHERE item.workspace_id = $1 AND item.resolved_at IS NULL`;
const columns = `SELECT item.id, item.kind, item.title, item.detail, item.detected_at AS "detectedAt", item.label_id AS "labelId",
  jsonb_build_object('id', c.id, 'displayName', c.display_name) AS channel,
  jsonb_build_object('text', item.detected_text,
    'suggestedPersonId', (SELECT CASE WHEN count(DISTINCT a.person_id) = 1 THEN min(a.person_id::text)::uuid END
      FROM aliases a JOIN people p ON p.id = a.person_id AND p.workspace_id = $1 AND p.active
      WHERE a.workspace_id = $1 AND lower(a.alias) = lower(item.detected_text)),
    'suggestedCategoryId', (SELECT id FROM vocab_domains WHERE workspace_id = $1 AND active AND lower(name) = lower(item.detected_text) LIMIT 1)) AS detected`;

export async function insertUnrouted(
  tx: PoolClient,
  scope: { workspaceId: string; labelId: string },
  now: Date,
) {
  await tx.query('SELECT id FROM labels WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
    scope.workspaceId,
    scope.labelId,
  ]);
  await tx.query(
    `INSERT INTO review_items (workspace_id, kind, title, detail, channel_id, label_id, detected_text, detected_at, created_at)
    SELECT $1, 'unrouted', 'No matching rule', coalesce(t.summary, ''), u.channel_id, l.id, d.name, $3, $3
    FROM labels l JOIN units u ON u.id = l.unit_id AND u.workspace_id = $1
    JOIN threads t ON t.id = l.thread_id AND t.workspace_id = $1
    JOIN vocab_domains d ON d.id = coalesce(l.domain_id, t.domain_id) AND d.workspace_id = $1
    WHERE l.workspace_id = $1 AND l.id = $2 AND NOT EXISTS (
      SELECT 1 FROM review_items item WHERE item.workspace_id = $1 AND item.label_id = l.id
        AND item.kind = 'unrouted' AND item.resolved_at IS NULL)`,
    [scope.workspaceId, scope.labelId, now],
  );
}

export async function reviewCounts(tx: PoolClient, workspaceId: string) {
  const { rows } = await tx.query<{ unrouted: number; alias: number; category: number }>(
    `SELECT count(*) FILTER (WHERE kind = 'unrouted')::int AS unrouted,
      count(*) FILTER (WHERE kind = 'alias')::int AS alias,
      count(*) FILTER (WHERE kind = 'category')::int AS category
    FROM review_items WHERE workspace_id = $1 AND resolved_at IS NULL`,
    [workspaceId],
  );

  return rows[0];
}

export async function selectReview(
  tx: PoolClient,
  workspaceId: string,
  input: ReturnType<typeof parseReviewQuery>,
) {
  const filtered = `${source} AND ($2::text IS NULL OR item.kind = $2)
    AND ($3::text IS NULL OR strpos(lower(concat_ws(' ', item.title, item.detail, c.display_name)), lower($3)) > 0)`;
  const filters = [workspaceId, input.kind ?? null, input.q || null];
  const total = await tx.query<{ total: number }>(
    'SELECT count(*)::int AS total ' + filtered,
    filters,
  );
  const result = await tx.query<ReviewRow>(
    `${columns} ${filtered}
    AND ($4::timestamptz IS NULL OR (item.detected_at, item.id) < ($4, $5::uuid))
    ORDER BY item.detected_at DESC, item.id DESC LIMIT $6`,
    [...filters, input.cursor?.at ?? null, input.cursor?.id ?? null, input.limit + 1],
  );

  return { rows: result.rows, total: total.rows[0].total };
}

export async function selectReviewItem(
  tx: PoolClient,
  workspaceId: string,
  id: string,
  lock = false,
) {
  const result = await tx.query<ReviewRow>(
    `${columns} ${source} AND item.id = $2 ${lock ? 'FOR UPDATE OF item' : ''}`,
    [workspaceId, id],
  );

  return result.rows[0];
}

export async function markResolved(
  tx: PoolClient,
  scope: { workspaceId: string; actorId: string },
  id: string,
  now: Date,
) {
  await tx.query(
    'UPDATE review_items SET resolved_at = $4, resolved_by = $3 WHERE workspace_id = $1 AND id = $2 AND resolved_at IS NULL',
    [scope.workspaceId, id, scope.actorId, now],
  );
}
