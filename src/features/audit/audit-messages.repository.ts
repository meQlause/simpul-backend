import type { PoolClient } from 'pg';
import type { MessageFacts, Outcome } from './audit-messages.rules.js';
import type { parseMessageQuery } from './audit-messages.schema.js';

export type MessageFilter = ReturnType<typeof parseMessageQuery> & { text: boolean };

type MessageDbRow = Omit<MessageFacts, 'occurredAt'> & { occurredAt: Date };

// Each table is reduced to one row per unit before it joins the units, so the workspace is read in
// a few hash joins instead of one lookup per unit. Outcome: a correction, a genesis link, an
// unretracted label, an unanswered question, NOISE, an open orphan, then pending.
// ponytail: outcome is derived per request over every unit of the workspace; store it on units when a workspace passes ~100k units
const messages = `WITH corrected AS MATERIALIZED (
  SELECT DISTINCT ON (uc.unit_id) uc.unit_id, uc.action, t.display_id
  FROM unit_corrections uc JOIN threads t ON t.id = uc.thread_id
  WHERE uc.workspace_id = $1
  ORDER BY uc.unit_id, uc.created_at DESC
), genesis AS MATERIALIZED (
  SELECT DISTINCT ON (um.unit_id) um.unit_id, t.display_id
  FROM unit_messages um
  JOIN message_thread_link mtl ON mtl.message_id = um.message_id AND mtl.role = 'genesis'
  JOIN threads t ON t.id = mtl.thread_id
  WHERE um.workspace_id = $1
  ORDER BY um.unit_id
), labelled AS MATERIALIZED (
  SELECT DISTINCT ON (l.unit_id) l.unit_id, t.display_id
  FROM labels l JOIN threads t ON t.id = l.thread_id
  WHERE l.workspace_id = $1 AND l.retracted_at IS NULL
  ORDER BY l.unit_id
), orphaned AS MATERIALIZED (
  SELECT DISTINCT ON (o.unit_id) o.unit_id, o.reason
  FROM orphans o
  WHERE o.workspace_id = $1 AND o.closed_at IS NULL
  ORDER BY o.unit_id, o.created_at DESC
), decided AS MATERIALIZED (
  SELECT DISTINCT ON (l.unit_id) l.unit_id, d.id
  FROM decisions d
  JOIN notifications n ON n.id = d.notification_id
  JOIN labels l ON l.id = n.label_id
  WHERE d.workspace_id = $1
  ORDER BY l.unit_id, d.occurred_at DESC
), resolved AS MATERIALIZED (
  SELECT DISTINCT ON (r.unit_id) r.unit_id, r.verdict, r.decided_by, r.context_message_count, r.candidates
  FROM unit_resolutions r
  WHERE r.workspace_id = $1
  ORDER BY r.unit_id
), candidates AS MATERIALIZED (
  SELECT r.unit_id, jsonb_agg(jsonb_build_object('displayId', t.display_id, 'summary', t.summary,
    'score', (cand->>'score')::float) ORDER BY (cand->>'score')::float DESC) AS list
  FROM resolved r
  CROSS JOIN LATERAL jsonb_array_elements(r.candidates) cand
  JOIN threads t ON t.id = (cand->>'threadId')::uuid AND t.workspace_id = $1
  GROUP BY r.unit_id
), signals AS MATERIALIZED (
  SELECT u.id AS "unitId", u.ts_last AS "occurredAt", u.triage_class AS "triageClass",
    jsonb_build_object('id', c.id, 'name', c.display_name) AS channel, p.name AS "senderName",
    CASE WHEN u.source = 'transcript' THEN u.text END AS "transcriptText",
    cr.action AS "correctionAction", cr.display_id AS "correctionDisplay",
    g.display_id AS "genesisDisplay", lb.display_id AS "labelDisplay",
    o.reason AS "orphanReason", oq.expires_at AS "questionExpiresAt", dd.id AS "decisionId",
    CASE WHEN rs.verdict IS NOT NULL THEN jsonb_build_object('verdict', rs.verdict,
      'decidedBy', rs.decided_by, 'contextMessages', rs.context_message_count,
      'candidates', COALESCE(cl.list, '[]'::jsonb)) END AS resolution
  FROM units u
  JOIN channels c ON c.id = u.channel_id AND c.workspace_id = $1
  LEFT JOIN people p ON p.id = u.sender_id AND p.workspace_id = $1
  LEFT JOIN open_questions oq ON oq.unit_id = u.id AND oq.answer IS NULL
  LEFT JOIN corrected cr ON cr.unit_id = u.id
  LEFT JOIN genesis g ON g.unit_id = u.id
  LEFT JOIN labelled lb ON lb.unit_id = u.id
  LEFT JOIN orphaned o ON o.unit_id = u.id
  LEFT JOIN decided dd ON dd.unit_id = u.id
  LEFT JOIN resolved rs ON rs.unit_id = u.id
  LEFT JOIN candidates cl ON cl.unit_id = u.id
  WHERE u.workspace_id = $1
), messages AS MATERIALIZED (
  SELECT "unitId", "occurredAt", "triageClass", channel, "senderName", "transcriptText", "decisionId", resolution,
    CASE WHEN "correctionAction" IS NOT NULL THEN jsonb_build_object('workDisplayId', "correctionDisplay",
      'action', "correctionAction") END AS correction,
    CASE WHEN COALESCE("correctionDisplay", "genesisDisplay", "labelDisplay") IS NOT NULL
      THEN jsonb_build_object('displayId', COALESCE("correctionDisplay", "genesisDisplay", "labelDisplay")) END AS work,
    CASE
      WHEN "correctionAction" = 'create' THEN 'created'
      WHEN "correctionAction" = 'attach' THEN 'attached'
      WHEN "genesisDisplay" IS NOT NULL THEN 'created'
      WHEN "labelDisplay" IS NOT NULL THEN 'attached'
      WHEN "questionExpiresAt" > $2 THEN 'held'
      WHEN "triageClass" = 'NOISE' THEN 'ignored'
      WHEN "orphanReason" IS NOT NULL AND ("triageClass" <> 'QUERY' OR "orphanReason" <> 'G1') THEN 'rejected'
      ELSE 'pending'
    END AS outcome,
    CASE
      WHEN "correctionAction" IS NOT NULL OR "genesisDisplay" IS NOT NULL OR "labelDisplay" IS NOT NULL THEN NULL
      WHEN "questionExpiresAt" > $2 THEN 'question'
      WHEN "triageClass" = 'NOISE' THEN 'NOISE'
      WHEN "triageClass" = 'QUERY' AND "orphanReason" = 'G1' THEN 'query'
      WHEN "orphanReason" IS NOT NULL THEN "orphanReason"
      WHEN "questionExpiresAt" IS NOT NULL THEN 'question_expired'
    END AS reason
  FROM signals
)`;

const matches = `($3::text IS NULL OR outcome = $3)
  AND ($4::text IS NULL OR strpos(lower(concat_ws(' ', work->>'displayId', "senderName", channel->>'name')), lower($4)) > 0)`;

export async function selectMessages(
  tx: PoolClient,
  workspaceId: string,
  filter: MessageFilter,
  now: Date,
) {
  const filters = [workspaceId, now, filter.outcome ?? null, filter.q || null];
  const total = await tx.query<{ total: number }>(
    `${messages} SELECT count(*)::int AS total FROM messages WHERE ${matches}`,
    filters,
  );
  const result = await tx.query<MessageDbRow>(
    `${messages} SELECT "unitId", "occurredAt", channel, "senderName",
      CASE WHEN $5::boolean THEN left(COALESCE("transcriptText", (SELECT string_agg(m.body_safe, E'\\n' ORDER BY m.server_ts, m.id)
        FROM unit_messages um JOIN messages_raw m ON m.id = um.message_id WHERE um.unit_id = messages."unitId")), 500) END AS text,
      outcome, reason, "triageClass",
      work, correction, resolution, "decisionId"
    FROM messages WHERE ${matches}
      AND ($6::timestamptz IS NULL OR ("occurredAt", "unitId") < ($6, $7::uuid))
    ORDER BY "occurredAt" DESC, "unitId" DESC LIMIT $8`,
    [
      ...filters,
      filter.text,
      filter.cursor?.at ?? null,
      filter.cursor?.id ?? null,
      filter.limit + 1,
    ],
  );

  return {
    rows: result.rows.map((row) => ({ ...row, occurredAt: row.occurredAt.toISOString() })),
    total: total.rows[0].total,
  };
}

export async function messageCounts(tx: PoolClient, workspaceId: string, now: Date) {
  const result = await tx.query<{ outcome: Outcome; n: number }>(
    `${messages} SELECT outcome, count(*)::int AS n FROM messages GROUP BY outcome`,
    [workspaceId, now],
  );

  return Object.assign(
    { created: 0, attached: 0, held: 0, rejected: 0, ignored: 0, pending: 0 },
    Object.fromEntries(result.rows.map((row) => [row.outcome, row.n])),
  );
}

export async function textAccess(tx: PoolClient, workspaceId: string) {
  const result = await tx.query<{ enabled: boolean }>(
    'SELECT message_text_access AS enabled FROM policies WHERE workspace_id = $1',
    [workspaceId],
  );

  return result.rows[0].enabled;
}

export async function insertAccessLog(
  tx: PoolClient,
  scope: { workspaceId: string; actorId: string },
  channelIds: string[],
  now: Date,
) {
  await tx.query(
    'INSERT INTO message_access_log (workspace_id, person_id, channel_id, accessed_at) SELECT $1, $2, channel_id, $3 FROM unnest($4::uuid[]) AS channel_id',
    [scope.workspaceId, scope.actorId, now, channelIds],
  );
}
