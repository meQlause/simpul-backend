import type { PoolClient } from 'pg';
import type { z as zod } from 'zod';
import type { personPatchSchema } from './people.schema.js';
import type { resolveRecipient } from './people.rules.js';

export async function selectReminderRecipient(
  tx: PoolClient,
  workspaceId: string,
  input: { ownerId: string | null; supervisor: boolean },
) {
  const result = await tx.query<{ personId: string }>(
    `WITH candidates AS (
      SELECT $2::uuid AS id, 0 AS priority WHERE NOT $3
      UNION ALL SELECT replacement.person_id, 1 FROM role_members holder
        JOIN role_members replacement ON replacement.workspace_id = $1 AND replacement.role_id = holder.role_id
        WHERE holder.workspace_id = $1 AND holder.person_id = $2 AND holder.kind = 'member'
          AND replacement.kind = 'backup' AND NOT $3
      UNION ALL SELECT manager_id, 2 FROM people WHERE workspace_id = $1 AND id = $2
      UNION ALL SELECT admin_person_id, 3 FROM workspaces WHERE id = $1
    ) SELECT p.id AS "personId" FROM candidates JOIN people p ON p.id = candidates.id
    WHERE p.workspace_id = $1 AND p.active AND p.availability = 'available'
    ORDER BY candidates.priority, p.id LIMIT 1`,
    [workspaceId, input.ownerId, input.supervisor],
  );

  return result.rows[0]?.personId ?? null;
}

type NamedPerson = { id: string; name: string };
type PersonDetail = NamedPerson & {
  level: 'staff' | 'executive';
  availability: 'available' | 'leave';
  identities: { provider: string; handle: string | null }[];
  telegramStatus: 'connected' | 'waiting' | 'not_connected';
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
    CASE WHEN EXISTS (SELECT 1 FROM person_identities WHERE workspace_id = $1 AND person_id = person.id
        AND provider = 'telegram' AND started_at IS NOT NULL) THEN 'connected'
      WHEN EXISTS (SELECT 1 FROM person_invites WHERE workspace_id = $1 AND person_id = person.id
        AND consumed_at IS NULL AND expires_at > now()) THEN 'waiting'
      ELSE 'not_connected' END AS "telegramStatus",
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
  roleId: string | null,
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

export async function insertPerson(
  tx: PoolClient,
  workspaceId: string,
  input: { id: string; name: string; roleName: string; team: string; handle: string | null },
) {
  await tx.query('INSERT INTO people (id, workspace_id, name) VALUES ($1, $2, $3)', [
    input.id,
    workspaceId,
    input.name,
  ]);
  const role = await tx.query<{ id: string }>(
    `INSERT INTO roles (workspace_id, role_key, name, team) VALUES ($1, 'person-' || $2::text, $3, $4)
    RETURNING id`,
    [workspaceId, input.id, input.roleName, input.team],
  );

  await tx.query(
    "INSERT INTO role_members (workspace_id, role_id, person_id, kind) VALUES ($1, $2, $3, 'member')",
    [workspaceId, role.rows[0].id, input.id],
  );
  await insertIdentity(tx, workspaceId, input.id, input.handle);
}

async function insertIdentity(
  tx: PoolClient,
  workspaceId: string,
  personId: string,
  handle: string | null,
) {
  if (handle) {
    await tx.query(
      "INSERT INTO person_identities (workspace_id, person_id, provider, handle) VALUES ($1, $2, 'telegram', $3)",
      [workspaceId, personId, handle],
    );
  }
}

export async function handleTaken(
  tx: PoolClient,
  workspaceId: string,
  handle: string,
  exceptPersonId: string | null,
) {
  const result = await tx.query(
    `SELECT 1 FROM person_identities AS identity JOIN people AS person ON person.id = identity.person_id
    WHERE identity.workspace_id = $1 AND identity.provider = 'telegram' AND lower(identity.handle) = lower($2)
    AND person.active AND ($3::uuid IS NULL OR identity.person_id <> $3)`,
    [workspaceId, handle, exceptPersonId],
  );

  return result.rowCount !== null && result.rowCount > 0;
}

export async function replaceIdentity(
  tx: PoolClient,
  workspaceId: string,
  personId: string,
  handle: string | null,
) {
  await tx.query(
    "DELETE FROM person_identities WHERE workspace_id = $1 AND person_id = $2 AND provider = 'telegram'",
    [workspaceId, personId],
  );
  await insertIdentity(tx, workspaceId, personId, handle);
}

export async function deactivatePerson(tx: PoolClient, workspaceId: string, personId: string) {
  await tx.query('UPDATE people SET active = false WHERE workspace_id = $1 AND id = $2', [
    workspaceId,
    personId,
  ]);
  // The username and the Telegram id go with the person, so someone else can take them.
  await tx.query('DELETE FROM person_identities WHERE workspace_id = $1 AND person_id = $2', [
    workspaceId,
    personId,
  ]);
  await tx.query('DELETE FROM person_invites WHERE workspace_id = $1 AND person_id = $2', [
    workspaceId,
    personId,
  ]);
}

export async function selectAdminPersonId(tx: PoolClient, workspaceId: string) {
  return (
    await tx.query<{ id: string | null }>(
      'SELECT admin_person_id AS id FROM workspaces WHERE id = $1',
      [workspaceId],
    )
  ).rows[0]?.id;
}

// ponytail: one UPDATE with a NOT EXISTS guard; two webhooks racing for the same Telegram id
// can still hit identities_external_uq and retry. A row lock per username is the upgrade path.
export async function linkSenderIdentity(
  tx: PoolClient,
  input: { workspaceId: string; provider: string; senderExternalId: string; senderHandle: string },
) {
  await tx.query(
    `UPDATE person_identities AS identity SET external_id = $3 FROM people AS person
    WHERE identity.workspace_id = $1 AND identity.provider = $2 AND lower(identity.handle) = lower($4)
    AND identity.external_id IS NULL AND person.id = identity.person_id AND person.active
    AND NOT EXISTS (SELECT 1 FROM person_identities AS taken WHERE taken.workspace_id = $1
      AND taken.provider = $2 AND taken.external_id = $3)`,
    [input.workspaceId, input.provider, input.senderExternalId, `@${input.senderHandle}`],
  );
}
