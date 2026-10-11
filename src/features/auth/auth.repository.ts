import type { Pool, PoolClient } from 'pg';

type InitialAccount = {
  id: string;
  name: string;
  email: string;
  token: string;
  expiresAt: Date;
  now: Date;
};

export async function insertInitialAccount(tx: PoolClient, account: InitialAccount) {
  await tx.query(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, false, $4, $4)`,
    [account.id, account.name, account.email, account.now],
  );
  await tx.query(
    `INSERT INTO account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
    VALUES ($1, $1, 'credential', $1, $2, $2)`,
    [account.id, account.now],
  );
  // Better Auth 1.7.7 consumes this verification atomically in its reset-password endpoint.
  await tx.query(
    `INSERT INTO verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $5)`,
    [account.token, `reset-password:${account.token}`, account.id, account.expiresAt, account.now],
  );
}

export async function findSessionPerson(pool: Pool, userId: string) {
  const result = await pool.query<{
    workspace_id: string;
    person_id: string | null;
  }>('SELECT * FROM workspace_for_session($1)', [userId]);

  return result.rows[0];
}

export async function isWorkspaceAdmin(tx: PoolClient, actorId: string) {
  const result = await tx.query(
    `SELECT 1 FROM workspaces AS workspace JOIN people AS person
    ON person.id = workspace.admin_person_id AND person.workspace_id = workspace.id
    WHERE person.id = $1 AND person.active`,
    [actorId],
  );

  return result.rowCount === 1;
}
