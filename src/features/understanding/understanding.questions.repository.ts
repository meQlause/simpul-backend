import type { PoolClient } from 'pg';
import { insertOrphan } from './understanding.repository.js';

type Scope = { workspaceId: string; unitId: string; channelId: string };
const maximumCandidates = 3;

export async function resolutionFacts(tx: PoolClient, scope: Omit<Scope, 'channelId'>) {
  const { rows } = await tx.query<{
    channelId: string;
    triageClass: string;
    thresholds: { attach: number; create: number; gap: number };
  }>(
    `SELECT u.channel_id AS "channelId", u.triage_class AS "triageClass", json_build_object(
      'attach', COALESCE((SELECT value FROM thresholds WHERE workspace_id = $1 AND scope = 'workspace' AND key = 'attach_threshold'), 0.75),
      'create', COALESCE((SELECT value FROM thresholds WHERE workspace_id = $1 AND scope = 'workspace' AND key = 'create_threshold'), 0.45),
      'gap', COALESCE((SELECT value FROM thresholds WHERE workspace_id = $1 AND scope = 'workspace' AND key = 'attach_gap'), 0.25)
    ) AS thresholds FROM units u JOIN channels c ON c.id = u.channel_id AND c.workspace_id = u.workspace_id
    WHERE u.workspace_id = $1 AND u.id = $2 FOR UPDATE OF c, u`,
    [scope.workspaceId, scope.unitId],
  );

  return rows[0];
}

export async function askQuestion(
  tx: PoolClient,
  scope: Scope,
  candidates: string[],
  now: Date,
): Promise<string | undefined> {
  const threadIds = candidates.slice(0, maximumCandidates);

  await tx.query(
    'SELECT id FROM threads WHERE workspace_id = $1 AND id = ANY($2) ORDER BY id FOR UPDATE',
    [scope.workspaceId, threadIds],
  );
  const existing = await tx.query(
    'SELECT id FROM open_questions WHERE workspace_id = $1 AND unit_id = $2',
    [scope.workspaceId, scope.unitId],
  );

  if (existing.rowCount) {
    return undefined;
  }

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO open_questions (workspace_id, unit_id, channel_id, thread_ids, asked_at, expires_at)
    SELECT w.id, $2, $3, $5, $4, $4::timestamptz + interval '10 minutes' FROM workspaces w
    WHERE w.id = $1 AND cardinality($5::uuid[]) BETWEEN 1 AND 3
    AND (SELECT count(*) FROM threads t WHERE t.workspace_id = $1 AND t.id = ANY($5) AND t.status IN ('active', 'tentative')) = cardinality($5::uuid[])
    AND (SELECT count(*) FROM open_questions q WHERE q.workspace_id = $1 AND q.channel_id = $3 AND (q.asked_at AT TIME ZONE w.timezone)::date = ($4::timestamptz AT TIME ZONE w.timezone)::date)
      < COALESCE((SELECT value FROM thresholds WHERE workspace_id = $1 AND scope = 'workspace' AND key = 'questions_per_channel_per_day'), 3)
    AND NOT EXISTS (SELECT 1 FROM unnest($5::uuid[]) t(id) WHERE
      (SELECT count(*) FROM open_questions q WHERE q.workspace_id = $1 AND t.id = ANY(q.thread_ids) AND (q.asked_at AT TIME ZONE w.timezone)::date = ($4::timestamptz AT TIME ZONE w.timezone)::date)
      >= COALESCE((SELECT value FROM thresholds WHERE workspace_id = $1 AND scope = 'workspace' AND key = 'questions_per_thread_per_day'), 1))
    RETURNING id`,
    [scope.workspaceId, scope.unitId, scope.channelId, now, threadIds],
  );

  if (!rows[0]) {
    await insertOrphan(tx, scope, 'question_quota');
  }

  return rows[0]?.id;
}

// The answer is a candidate's thread id or 'none'; only an open, unexpired question takes it.
export async function answerQuestion(
  tx: PoolClient,
  input: { workspaceId: string; questionId: string; actorId: string; answer: string },
  now: Date,
): Promise<string | undefined> {
  const { rows } = await tx.query<{ unitId: string }>(
    `UPDATE open_questions SET answer = $3, answered_by = $4
    WHERE workspace_id = $1 AND id = $2 AND answer IS NULL AND unit_id IS NOT NULL AND expires_at > $5
    AND ($3 = 'none' OR $3 = ANY(thread_ids::text[]))
    RETURNING unit_id AS "unitId"`,
    [input.workspaceId, input.questionId, input.answer, input.actorId, now],
  );

  return rows[0]?.unitId;
}
