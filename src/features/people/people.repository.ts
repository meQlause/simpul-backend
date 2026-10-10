import type { PoolClient } from 'pg';
import type { z as zod } from 'zod';
import type { personPatchSchema } from './people.schema.js';
import type { resolveRecipient } from './people.rules.js';

type NamedPerson = { id: string; name: string };
type PersonDetail = NamedPerson & {
  level: 'staff' | 'executive';
  availability: 'available' | 'leave';
  identities: { provider: string; handle: string | null }[];
  role: (NamedPerson & { team: string }) | null;
  manager: NamedPerson | null;
  backup: NamedPerson | null;
};
type Patch = zod.infer<typeof personPatchSchema>;

export async function insertAdminPerson(
  tx: PoolClient,
  input: {
    id: string;
    workspaceId: string;
    name: string;
    email: string;
    authUserId: string;
    now: Date;
  },
) {
  await tx.query(
    `INSERT INTO people (id, workspace_id, name, email, auth_user_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.id, input.workspaceId, input.name, input.email, input.authUserId, input.now],
  );
}

export async function selectPeople(
  tx: PoolClient,
  workspaceId: string,
  personId: string | null = null,
) {
  const result = await tx.query<PersonDetail>(
    `SELECT person.id, person.name, person.level, person.availability,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('provider', provider, 'handle', handle) ORDER BY provider)
      FROM person_identities WHERE workspace_id = $1 AND person_id = person.id), '[]') AS identities,
    (SELECT jsonb_build_object('id', role.id, 'name', role.name, 'team', role.team)
      FROM roles AS role JOIN role_members AS member ON member.role_id = role.id
      WHERE member.person_id = person.id AND member.kind = 'member' AND role.workspace_id = $1
      ORDER BY role.name LIMIT 1) AS role,
    (SELECT jsonb_build_object('id', manager.id, 'name', manager.name)
      FROM people AS manager WHERE manager.id = person.manager_id AND manager.workspace_id = $1 AND manager.active) AS manager,
    (SELECT jsonb_build_object('id', backup.id, 'name', backup.name)
      FROM role_members AS holder JOIN role_members AS replacement ON replacement.role_id = holder.role_id
      JOIN people AS backup ON backup.id = replacement.person_id
      WHERE holder.person_id = person.id AND holder.kind = 'member' AND replacement.kind = 'backup'
      AND backup.workspace_id = $1 AND backup.active ORDER BY backup.id LIMIT 1) AS backup
    FROM people AS person WHERE person.workspace_id = $1 AND person.active AND ($2::uuid IS NULL OR person.id = $2)
    ORDER BY person.name`,
    [workspaceId, personId],
  );
  return result.rows;
}

export async function lockPerson(tx: PoolClient, workspaceId: string, personId: string) {
  await tx.query('SELECT id FROM people WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
    workspaceId,
    personId,
  ]);
}

export async function selectActiveIds(tx: PoolClient, workspaceId: string, ids: string[]) {
  return (
    await tx.query<{ id: string }>(
      'SELECT id FROM people WHERE workspace_id = $1 AND active AND id = ANY($2::uuid[])',
      [workspaceId, ids],
    )
  ).rows.map((person) => person.id);
}

export async function updatePerson(
  tx: PoolClient,
  workspaceId: string,
  personId: string,
  input: Patch,
) {
  await tx.query(
    `UPDATE people SET availability = COALESCE($3, availability), manager_id = COALESCE($4, manager_id)
    WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, personId, input.availability, input.managerId],
  );
}

export async function updateRole(
  tx: PoolClient,
  workspaceId: string,
  roleId: string,
  input: Patch,
) {
  if (input.roleName !== undefined) {
    await tx.query('UPDATE roles SET name = $3 WHERE workspace_id = $1 AND id = $2', [
      workspaceId,
      roleId,
      input.roleName,
    ]);
  }
  if (input.backupPersonId !== undefined) {
    await tx.query('SELECT id FROM roles WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
      workspaceId,
      roleId,
    ]);
    await tx.query(
      "DELETE FROM role_members WHERE workspace_id = $1 AND role_id = $2 AND kind = 'backup'",
      [workspaceId, roleId],
    );
    await tx.query(
      "INSERT INTO role_members (workspace_id, role_id, person_id, kind) VALUES ($1, $2, $3, 'backup')",
      [workspaceId, roleId, input.backupPersonId],
    );
  }
}

export async function selectRecipientCandidates(
  tx: PoolClient,
  workspaceId: string,
  roleId: string,
) {
  const result = await tx.query<Parameters<typeof resolveRecipient>[0]>(
    `SELECT
    (SELECT jsonb_build_object('id', person.id, 'active', person.active, 'availability', person.availability)
      FROM role_members JOIN people AS person ON person.id = person_id
      WHERE role_members.workspace_id = $1 AND person.workspace_id = $1 AND role_id = $2 AND kind = 'member' ORDER BY person.id LIMIT 1) AS holder,
    (SELECT jsonb_build_object('id', person.id, 'active', person.active, 'availability', person.availability)
      FROM role_members JOIN people AS person ON person.id = person_id
      WHERE role_members.workspace_id = $1 AND person.workspace_id = $1 AND role_id = $2 AND kind = 'backup' ORDER BY person.id LIMIT 1) AS backup,
    (SELECT jsonb_build_object('id', manager.id, 'active', manager.active, 'availability', manager.availability)
      FROM role_members JOIN people AS holder ON holder.id = person_id JOIN people AS manager ON manager.id = holder.manager_id
      WHERE role_members.workspace_id = $1 AND role_id = $2 AND kind = 'member' AND manager.workspace_id = $1 ORDER BY holder.id LIMIT 1) AS supervisor,
    (SELECT jsonb_build_object('id', person.id, 'active', person.active, 'availability', person.availability)
      FROM workspaces JOIN people AS person ON person.id = admin_person_id WHERE workspaces.id = $1 AND person.workspace_id = $1) AS admin`,
    [workspaceId, roleId],
  );
  return result.rows[0];
}
