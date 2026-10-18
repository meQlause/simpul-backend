import type { PoolClient } from 'pg';

// The workspace's Telegram bot, only while its connection is ready (FR-UI-24).
export async function readyBot(tx: PoolClient, workspaceId: string) {
  const result = await tx.query<{
    id: string;
    botUsername: string;
    tokenRef: string;
    providerAccountId: string;
  }>(
    `SELECT id, bot_username AS "botUsername", token_secret_ref AS "tokenRef",
      provider_account_id AS "providerAccountId" FROM bot_connections
    WHERE workspace_id = $1 AND provider = 'telegram' AND status = 'ready'`,
    [workspaceId],
  );

  return result.rows[0];
}

// One live invite per person: a new code replaces the row, so the older link stops matching.
export async function upsertInvite(
  tx: PoolClient,
  workspaceId: string,
  invite: {
    personId: string;
    botConnectionId: string;
    codeHash: Buffer;
    createdAt: Date;
    expiresAt: Date;
    createdBy: string;
  },
) {
  await tx.query(
    `INSERT INTO person_invites (workspace_id, person_id, bot_connection_id, code_hash, created_at, expires_at, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (workspace_id, person_id) DO UPDATE SET bot_connection_id = EXCLUDED.bot_connection_id,
      code_hash = EXCLUDED.code_hash, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at,
      created_by = EXCLUDED.created_by, consumed_at = NULL`,
    [
      workspaceId,
      invite.personId,
      invite.botConnectionId,
      invite.codeHash,
      invite.createdAt,
      invite.expiresAt,
      invite.createdBy,
    ],
  );
}

// A live invite of an active person, locked so two Starts with the same code link once.
export async function inviteByHash(
  tx: PoolClient,
  workspaceId: string,
  codeHash: Buffer,
  now: Date,
) {
  const result = await tx.query<{ id: string; personId: string }>(
    `SELECT invite.id, invite.person_id AS "personId" FROM person_invites AS invite
    JOIN people AS person ON person.id = invite.person_id AND person.active
    WHERE invite.workspace_id = $1 AND invite.code_hash = $2 AND invite.consumed_at IS NULL
      AND invite.expires_at > $3
    FOR UPDATE OF invite`,
    [workspaceId, codeHash, now],
  );

  return result.rows[0];
}

export async function linkedPersonId(tx: PoolClient, workspaceId: string, externalId: string) {
  const result = await tx.query<{ personId: string }>(
    `SELECT identity.person_id AS "personId" FROM person_identities AS identity
    JOIN people AS person ON person.id = identity.person_id AND person.active
    WHERE identity.workspace_id = $1 AND identity.provider = 'telegram' AND identity.external_id = $2`,
    [workspaceId, externalId],
  );

  return result.rows[0]?.personId;
}

// The verified account takes its username: another person's identity that only held that
// username (no Telegram id) is removed, since an identity needs one of the two.
export async function linkInvited(
  tx: PoolClient,
  workspaceId: string,
  link: {
    personId: string;
    inviteId: string;
    externalId: string;
    handle: string | null;
    now: Date;
  },
) {
  if (link.handle) {
    await tx.query(
      `DELETE FROM person_identities WHERE workspace_id = $1 AND provider = 'telegram'
      AND lower(handle) = lower($2) AND external_id IS NULL AND person_id <> $3`,
      [workspaceId, link.handle, link.personId],
    );
  }

  await tx.query(
    `INSERT INTO person_identities (workspace_id, person_id, provider, external_id, handle, started_at)
    VALUES ($1, $2, 'telegram', $3, $4, $5)
    ON CONFLICT (person_id, provider) DO UPDATE SET external_id = EXCLUDED.external_id,
      handle = EXCLUDED.handle, started_at = EXCLUDED.started_at`,
    [workspaceId, link.personId, link.externalId, link.handle, link.now],
  );
  await tx.query('UPDATE person_invites SET consumed_at = $3 WHERE workspace_id = $1 AND id = $2', [
    workspaceId,
    link.inviteId,
    link.now,
  ]);
}

export async function markStarted(
  tx: PoolClient,
  workspaceId: string,
  externalId: string,
  now: Date,
) {
  const result = await tx.query(
    `UPDATE person_identities AS identity SET started_at = $3 FROM people AS person
    WHERE identity.workspace_id = $1 AND identity.provider = 'telegram' AND identity.external_id = $2
      AND person.id = identity.person_id AND person.active`,
    [workspaceId, externalId, now],
  );

  return Boolean(result.rowCount);
}
