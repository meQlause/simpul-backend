import type { PoolClient } from 'pg';

const overviewStatement = `WITH local_day AS (
      SELECT timezone, date_trunc('day', $3::timestamptz AT TIME ZONE timezone) AS today,
        CASE WHEN $2 = 'week' THEN interval '7 days' ELSE interval '1 day' END AS span
      FROM workspaces WHERE id = $1
    ), bounds AS (
      SELECT today AT TIME ZONE timezone AS today_start,
        (today + interval '1 day') AT TIME ZONE timezone AS finish,
        (today + interval '1 day' - span) AT TIME ZONE timezone AS start,
        (today + interval '1 day' - span - span) AT TIME ZONE timezone AS previous
      FROM local_day
    ), clock AS (
      SELECT $3::timestamptz AT TIME ZONE timezone AS local_now FROM local_day
    ), message_buckets AS (
      -- FR-UI-22: today is one bucket per elapsed local hour; week is seven local days ending today.
      SELECT g AS idx, (ld.today + g * interval '1 hour') AT TIME ZONE ld.timezone AS bucket_start,
        (ld.today + (g + 1) * interval '1 hour') AT TIME ZONE ld.timezone AS bucket_end
      FROM local_day ld CROSS JOIN clock CROSS JOIN generate_series(0, extract(hour FROM clock.local_now)::int) g
      WHERE $2 = 'today'
      UNION ALL
      SELECT g, (ld.today + (g - 6) * interval '1 day') AT TIME ZONE ld.timezone,
        (ld.today + (g - 5) * interval '1 day') AT TIME ZONE ld.timezone
      FROM local_day ld CROSS JOIN generate_series(0, 6) g
      WHERE $2 = 'week'
    ), work_buckets AS (
      -- Nine local hours ending with the current one; a week is seven local days ending today.
      SELECT g AS idx, (date_trunc('hour', clock.local_now) - interval '8 hours' + g * interval '1 hour') AT TIME ZONE ld.timezone AS bucket_start,
        (date_trunc('hour', clock.local_now) - interval '7 hours' + g * interval '1 hour') AT TIME ZONE ld.timezone AS bucket_end
      FROM local_day ld CROSS JOIN clock CROSS JOIN generate_series(0, 8) g
      WHERE $2 = 'today'
      UNION ALL
      SELECT g, (ld.today + (g - 6) * interval '1 day') AT TIME ZONE ld.timezone,
        (ld.today + (g - 5) * interval '1 day') AT TIME ZONE ld.timezone
      FROM local_day ld CROSS JOIN generate_series(0, 6) g
      WHERE $2 = 'week'
    ), message_series AS (
      SELECT b.idx, count(u.id)::int AS n
      FROM message_buckets b
      LEFT JOIN units u ON u.workspace_id = $1 AND u.triage_class <> 'NOISE'
        AND u.ts_last >= b.bucket_start AND u.ts_last < b.bucket_end
      GROUP BY b.idx
    ), work_series AS (
      SELECT b.idx, count(DISTINCT l.thread_id)::int AS n
      FROM work_buckets b
      JOIN messages_raw m ON m.workspace_id = $1 AND m.server_ts >= b.bucket_start AND m.server_ts < b.bucket_end
      JOIN message_thread_link l ON l.workspace_id = $1 AND l.message_id = m.id
      JOIN threads t ON t.workspace_id = $1 AND t.id = l.thread_id
      GROUP BY b.idx
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
        'trendPercent', round(100.0 * (m.current - m.previous) / nullif(m.previous, 0), 1)::text,
        'series', (SELECT coalesce(jsonb_agg(n ORDER BY idx), '[]'::jsonb) FROM message_series)),
      'activeWork', jsonb_build_object('count', w.count, 'completedToday', w.completed,
        'series', (SELECT coalesce(jsonb_agg(coalesce(s.n, 0) ORDER BY b.idx), '[]'::jsonb)
          FROM work_buckets b LEFT JOIN work_series s ON s.idx = b.idx)),
      'updatesDelivered', jsonb_build_object('count', (SELECT count(*)::int FROM delivered),
        'recipients', (SELECT count(DISTINCT recipient_person_id)::int FROM delivered),
        'topRecipients', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', name) ORDER BY total DESC, id), '[]') FROM top_recipients)),
      'needsReview', jsonb_build_object('count', r.count,
        'byKind', jsonb_build_object('unrouted', r.unrouted, 'alias', r.alias, 'category', r.category), 'areas', r.areas)
    ) AS data FROM messages m CROSS JOIN work w CROSS JOIN review r CROSS JOIN bounds`;

export async function overviewRows(tx: PoolClient, workspaceId: string, period: string, now: Date) {
  const { rows } = await tx.query<{ data: Record<string, unknown> }>(overviewStatement, [
    workspaceId,
    period,
    now,
  ]);

  return rows[0]?.data;
}
