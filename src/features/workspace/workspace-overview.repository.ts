import type { PoolClient } from 'pg';

export async function overviewRows(tx: PoolClient, workspaceId: string, period: string, now: Date) {
  const { rows } = await tx.query<{ data: Record<string, unknown> }>(
    `WITH local_day AS (
      SELECT timezone, date_trunc('day', $3::timestamptz AT TIME ZONE timezone) AS today,
        CASE WHEN $2 = 'week' THEN interval '7 days' ELSE interval '1 day' END AS span
      FROM workspaces WHERE id = $1
    ), bounds AS (
      SELECT today AT TIME ZONE timezone AS today_start,
        (today + interval '1 day') AT TIME ZONE timezone AS finish,
        (today + interval '1 day' - span) AT TIME ZONE timezone AS start,
        (today + interval '1 day' - span - span) AT TIME ZONE timezone AS previous
      FROM local_day
    ), messages AS (
      SELECT count(*) FILTER (WHERE ts_last >= b.start)::int AS current,
        count(*) FILTER (WHERE ts_last < b.start)::int AS previous
      FROM units CROSS JOIN bounds b
      WHERE workspace_id = $1 AND triage_class <> 'NOISE'
        AND ts_last >= b.previous AND ts_last < b.finish
    ), work AS (
      SELECT count(*) FILTER (WHERE CASE WHEN $2 = 'today' THEN status = 'active'
        ELSE last_activity_at >= b.start AND last_activity_at < b.finish END)::int AS count,
        count(*) FILTER (WHERE closure_kind = 'completed' AND closed_at >= b.today_start
          AND closed_at < b.finish)::int AS completed
      FROM threads CROSS JOIN bounds b WHERE workspace_id = $1
    ), delivered AS (
      SELECT recipient_person_id FROM notifications CROSS JOIN bounds b
      WHERE workspace_id = $1 AND sent_at >= b.start AND sent_at < b.finish
    ), top_recipients AS (
      SELECT p.id, p.name, count(*) AS total FROM delivered d
      JOIN people p ON p.id = d.recipient_person_id AND p.workspace_id = $1
      GROUP BY p.id ORDER BY total DESC, p.id LIMIT 2
    ), review AS (
      SELECT count(*)::int AS count,
        count(*) FILTER (WHERE kind = 'unrouted')::int AS unrouted,
        count(*) FILTER (WHERE kind = 'alias')::int AS alias,
        count(*) FILTER (WHERE kind = 'category')::int AS category,
        count(DISTINCT kind)::int AS areas
      FROM review_items WHERE workspace_id = $1 AND resolved_at IS NULL
    )
    SELECT jsonb_build_object(
      'period', $2::text,
      'messagesUnderstood', jsonb_build_object('count', m.current,
        'trendPercent', round(100.0 * (m.current - m.previous) / nullif(m.previous, 0), 1)::text),
      'activeWork', jsonb_build_object('count', w.count, 'completedToday', w.completed),
      'updatesDelivered', jsonb_build_object('count', (SELECT count(*)::int FROM delivered),
        'recipients', (SELECT count(DISTINCT recipient_person_id)::int FROM delivered),
        'topRecipients', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', name) ORDER BY total DESC, id), '[]') FROM top_recipients)),
      'needsReview', jsonb_build_object('count', r.count,
        'byKind', jsonb_build_object('unrouted', r.unrouted, 'alias', r.alias, 'category', r.category), 'areas', r.areas)
    ) AS data FROM messages m CROSS JOIN work w CROSS JOIN review r CROSS JOIN bounds`,
    [workspaceId, period, now],
  );

  return rows[0]?.data;
}
