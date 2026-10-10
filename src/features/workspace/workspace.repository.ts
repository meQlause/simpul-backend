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
