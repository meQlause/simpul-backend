import type { PoolClient } from 'pg';
import type { z as zod } from 'zod';
import type { createWorkspaceSchema, settingsSchema } from './workspace.schema.js';

const DEFAULT_DIGEST_TIME = '08:30';

export type WorkspaceProvision = {
  input: zod.infer<typeof createWorkspaceSchema>;
  workspaceId: string;
  adminId: string;
  authUserId: string;
  token: string;
  now: Date;
  expiresAt: Date;
};

export async function insertWorkspace(tx: PoolClient, provision: WorkspaceProvision) {
  await tx.query(
    `INSERT INTO workspaces (id, name, timezone, created_at)
    VALUES ($1, $2, $3, $4)`,
    [provision.workspaceId, provision.input.name, provision.input.timezone, provision.now],
  );
}

export async function finishWorkspaceProvision(
  tx: PoolClient,
  workspaceId: string,
  adminId: string,
) {
  await tx.query('UPDATE workspaces SET admin_person_id = $1 WHERE id = $2', [
    adminId,
    workspaceId,
  ]);
  await tx.query('INSERT INTO policies (workspace_id, digest_time) VALUES ($1, $2)', [
    workspaceId,
    DEFAULT_DIGEST_TIME,
  ]);
}

type WorkspaceMe = {
  person_id: string;
  person_name: string;
  role_name: string | null;
  workspace_id: string;
  workspace_name: string;
  descriptor: string | null;
  timezone: string;
  onboarding_completed_at: Date | null;
  members: number;
  channels: number;
  active_rules: number;
};

export async function selectMe(tx: PoolClient, scope: { workspaceId: string; actorId: string }) {
  const result = await tx.query<WorkspaceMe>(
    `SELECT person.id AS person_id, person.name AS person_name,
    (SELECT role.name FROM roles AS role JOIN role_members AS member ON member.role_id = role.id
      WHERE member.person_id = person.id AND member.kind = 'member' ORDER BY role.name LIMIT 1) AS role_name,
    workspace.id AS workspace_id, workspace.name AS workspace_name, workspace.descriptor,
    workspace.timezone, workspace.onboarding_completed_at,
    (SELECT count(DISTINCT person_id)::int FROM role_members WHERE workspace_id = $1 AND kind = 'member') AS members,
    (SELECT count(*)::int FROM channels WHERE workspace_id = $1) AS channels,
    (SELECT count(*)::int FROM rules WHERE workspace_id = $1 AND active) AS active_rules
    FROM workspaces AS workspace JOIN people AS person ON person.workspace_id = workspace.id
    WHERE workspace.id = $1 AND person.id = $2`,
    [scope.workspaceId, scope.actorId],
  );

  return result.rows[0];
}

type Settings = zod.infer<typeof settingsSchema> & { holdSeconds: number; timezone: string };

export async function selectSettings(tx: PoolClient, workspaceId: string) {
  const result = await tx.query<Settings & { id: string }>(
    `SELECT policy.id, to_char(quiet_start, 'HH24:MI') AS "quietStart",
    to_char(quiet_end, 'HH24:MI') AS "quietEnd", budget_per_hour AS "budgetPerHour",
    to_char(digest_time, 'HH24:MI') AS "digestTime", hold_seconds AS "holdSeconds", workspace.timezone
    FROM policies AS policy JOIN workspaces AS workspace ON workspace.id = policy.workspace_id
    WHERE policy.workspace_id = $1 FOR UPDATE OF policy`,
    [workspaceId],
  );

  return result.rows[0];
}

export async function updateSettings(
  tx: PoolClient,
  workspaceId: string,
  input: zod.infer<typeof settingsSchema>,
) {
  await tx.query(
    `UPDATE policies SET quiet_start = $2, quiet_end = $3, budget_per_hour = $4,
    digest_time = $5 WHERE workspace_id = $1`,
    [workspaceId, input.quietStart, input.quietEnd, input.budgetPerHour, input.digestTime],
  );
}
