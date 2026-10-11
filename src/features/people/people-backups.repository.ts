import type { PoolClient } from 'pg';

export async function backupRoster(tx: PoolClient, workspaceId: string) {
  const roles = await tx.query<{ id: string; members: string[]; backups: string[] }>(
    `SELECT role.id,
    ARRAY(SELECT person_id FROM role_members WHERE workspace_id = $1 AND role_id = role.id AND kind = 'member') AS members,
    ARRAY(SELECT person_id FROM role_members WHERE workspace_id = $1 AND role_id = role.id AND kind = 'backup') AS backups
    FROM roles role WHERE role.workspace_id = $1 AND role.active FOR UPDATE OF role`,
    [workspaceId],
  );
  const people = await tx.query<{ id: string }>(
    'SELECT id FROM people WHERE workspace_id = $1 AND active FOR SHARE',
    [workspaceId],
  );

  return { roles: roles.rows, people: people.rows.map((person) => person.id) };
}
