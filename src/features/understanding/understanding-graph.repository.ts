import type { PoolClient } from 'pg';

const nodeBudget = 40;

export type GraphNode = { id: string; type: string; weight: number; hop: 1 | 2 };

export async function traverseGraph(tx: PoolClient, workspaceId: string, rootIds: string[]) {
  const roots = [...new Set(rootIds)].slice(0, nodeBudget);

  if (roots.length === 0) {
    return [];
  }

  const first = await tx.query<GraphNode>(
    `WITH adjacent AS (
      SELECT CASE WHEN e.from_id = roots.id THEN e.to_id ELSE e.from_id END AS id, e.weight
      FROM unnest($2::uuid[]) AS roots(id)
      JOIN edges e ON e.workspace_id = $1 AND (e.from_id = roots.id OR e.to_id = roots.id)
      WHERE e.created_by <> 'ai_inferred' OR coalesce(e.confidence, 0) >= 0.7
    ), ranked AS (
      SELECT id, max(weight)::float8 AS weight FROM adjacent GROUP BY id
    )
    SELECT n.id, n.type, ranked.weight, 1 AS hop
    FROM ranked JOIN nodes n ON n.id = ranked.id AND n.workspace_id = $1
    ORDER BY ranked.weight DESC, n.id LIMIT $3`,
    [workspaceId, roots, nodeBudget - roots.length],
  );
  const firstIds = [...new Set(first.rows.map((node) => node.id))];
  const remaining = nodeBudget - roots.length - firstIds.length;

  if (firstIds.length === 0 || remaining <= 0) {
    return first.rows;
  }

  const second = await tx.query<GraphNode>(
    `WITH adjacent AS (
      SELECT CASE WHEN e.from_id = prior.id THEN e.to_id ELSE e.from_id END AS id, e.weight
      FROM unnest($2::uuid[]) AS prior(id)
      JOIN edges e ON e.workspace_id = $1 AND (e.from_id = prior.id OR e.to_id = prior.id)
      WHERE (e.created_by <> 'ai_inferred' OR coalesce(e.confidence, 0) >= 0.7)
        AND CASE WHEN e.from_id = prior.id THEN e.to_id ELSE e.from_id END <> ALL($3::uuid[])
    ), ranked AS (
      SELECT id, max(weight)::float8 AS weight FROM adjacent GROUP BY id
    )
    SELECT n.id, n.type, ranked.weight, 2 AS hop
    FROM ranked JOIN nodes n ON n.id = ranked.id AND n.workspace_id = $1
    ORDER BY ranked.weight DESC, n.id LIMIT $4`,
    [workspaceId, firstIds, [...roots, ...firstIds], remaining],
  );

  return [...first.rows, ...second.rows];
}
