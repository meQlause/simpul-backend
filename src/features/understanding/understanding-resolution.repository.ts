import type { PoolClient } from 'pg';

type Scope = { workspaceId: string; unitId: string };
type Candidate = { threadId: string; score: number };

const maximumCandidates = 3;
const defaultWindowMinutes = 30;
const defaultMaximumMessages = 10;

// The conversation window and cap are read from `thresholds` and clamped (FR-RES-01).
const contextSettings = `
  WITH settings AS (
    SELECT LEAST(180, GREATEST(0, COALESCE((SELECT value FROM thresholds WHERE workspace_id = $1 AND scope = 'workspace' AND key = 'context_window_minutes'), ${defaultWindowMinutes})))::int AS minutes,
           LEAST(30, GREATEST(1, COALESCE((SELECT value FROM thresholds WHERE workspace_id = $1 AND scope = 'workspace' AND key = 'context_max_messages'), ${defaultMaximumMessages})))::int AS cap
  ),
  unit AS (SELECT channel_id, ts_first FROM units WHERE workspace_id = $1 AND id = $2)`;

export async function recordResolution(
  tx: PoolClient,
  scope: Scope,
  input: {
    verdict: string;
    decidedBy: string;
    candidates: Candidate[];
    chosenThreadId: string | null;
  },
) {
  await tx.query(
    `INSERT INTO unit_resolutions (workspace_id, unit_id, verdict, decided_by, candidates, chosen_thread_id, context_message_count)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, 0)
     ON CONFLICT (unit_id) DO UPDATE SET verdict = EXCLUDED.verdict, decided_by = EXCLUDED.decided_by,
       candidates = EXCLUDED.candidates, chosen_thread_id = EXCLUDED.chosen_thread_id, context_message_count = 0`,
    [
      scope.workspaceId,
      scope.unitId,
      input.verdict,
      input.decidedBy,
      JSON.stringify(input.candidates.slice(0, maximumCandidates)),
      input.chosenThreadId,
    ],
  );
}

export async function readResolution(tx: PoolClient, scope: Scope) {
  const { rows } = await tx.query<{
    verdict: string;
    decidedBy: string;
    candidateIds: string[];
    chosenThreadId: string | null;
  }>(
    `SELECT verdict, decided_by AS "decidedBy",
       ARRAY(SELECT c->>'threadId' FROM jsonb_array_elements(candidates) AS c) AS "candidateIds",
       chosen_thread_id AS "chosenThreadId"
     FROM unit_resolutions WHERE workspace_id = $1 AND unit_id = $2 FOR UPDATE`,
    [scope.workspaceId, scope.unitId],
  );

  return rows[0];
}

export async function settleResolution(
  tx: PoolClient,
  scope: Scope,
  patch: { decidedBy?: string; chosenThreadId?: string; contextMessageCount?: number },
) {
  await tx.query(
    `UPDATE unit_resolutions SET
       decided_by = coalesce($3::text, decided_by),
       chosen_thread_id = coalesce($4::uuid, chosen_thread_id),
       context_message_count = coalesce($5::int, context_message_count)
     WHERE workspace_id = $1 AND unit_id = $2`,
    [
      scope.workspaceId,
      scope.unitId,
      patch.decidedBy ?? null,
      patch.chosenThreadId ?? null,
      patch.contextMessageCount ?? null,
    ],
  );
}

// Earlier messages of the same channel inside the window, oldest first, never the unit's own.
export async function conversationContext(tx: PoolClient, scope: Scope) {
  const { rows } = await tx.query<{ messageId: string; text: string }>(
    `${contextSettings}
     SELECT id AS "messageId", text FROM (
       SELECT m.id, m.body_safe AS text, m.server_ts
       FROM messages_raw m CROSS JOIN settings CROSS JOIN unit
       WHERE m.workspace_id = $1 AND m.channel_id = unit.channel_id AND m.origin = 'user'
         AND m.body_safe <> '' AND m.server_ts < unit.ts_first
         AND m.server_ts >= unit.ts_first - (settings.minutes * interval '1 minute')
         AND m.id NOT IN (SELECT message_id FROM unit_messages WHERE workspace_id = $1 AND unit_id = $2)
       ORDER BY m.server_ts DESC LIMIT (SELECT cap FROM settings)
     ) recent ORDER BY server_ts`,
    [scope.workspaceId, scope.unitId],
  );

  return rows;
}

// Active or tentative work in the given order, as the grey choice is offered it.
export async function greyCandidates(tx: PoolClient, workspaceId: string, threadIds: string[]) {
  const { rows } = await tx.query<{
    id: string;
    displayId: string;
    customer: string | null;
    summary: string;
  }>(
    `SELECT t.id, t.display_id AS "displayId", t.customer_label AS customer, t.summary
     FROM unnest($2::uuid[]) WITH ORDINALITY AS wanted(id, position)
     JOIN threads t ON t.workspace_id = $1 AND t.id = wanted.id AND t.status IN ('active', 'tentative')
     ORDER BY wanted.position`,
    [workspaceId, threadIds],
  );

  return rows;
}

// Work created from a message inside the window: the candidates of a follow-up (FR-RES-03).
export async function recentGenesis(tx: PoolClient, scope: Scope) {
  const { rows } = await tx.query<{ threadId: string }>(
    `${contextSettings}
     SELECT t.id AS "threadId"
     FROM threads t
     JOIN message_thread_link l ON l.workspace_id = $1 AND l.thread_id = t.id AND l.role = 'genesis'
     JOIN messages_raw m ON m.workspace_id = $1 AND m.id = l.message_id
     CROSS JOIN settings CROSS JOIN unit
     WHERE t.workspace_id = $1 AND t.status IN ('active', 'tentative')
       AND m.channel_id = unit.channel_id
       AND m.server_ts < unit.ts_first
       AND m.server_ts >= unit.ts_first - (settings.minutes * interval '1 minute')
     GROUP BY t.id
     ORDER BY max(m.server_ts) DESC
     LIMIT ${maximumCandidates}`,
    [scope.workspaceId, scope.unitId],
  );

  return rows.map((row) => row.threadId);
}
