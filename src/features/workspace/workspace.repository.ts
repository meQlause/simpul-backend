import type { PoolClient } from 'pg';
import type { z as zod } from 'zod';
import type { createWorkspaceSchema } from './workspace.schema.js';

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
  await tx.query(
    `INSERT INTO people (id, workspace_id, name, email, auth_user_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      provision.adminId,
      provision.workspaceId,
      provision.input['admin-name'],
      provision.input['admin-email'],
      provision.authUserId,
      provision.now,
    ],
  );
  await tx.query('UPDATE workspaces SET admin_person_id = $1 WHERE id = $2', [
    provision.adminId,
    provision.workspaceId,
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
