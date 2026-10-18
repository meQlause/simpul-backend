import type { PoolClient } from 'pg';

// The workspace's Telegram bot, only while its connection is ready (FR-UI-24).
export async function readyBot(tx: PoolClient, workspaceId: string) {
  const result = await tx.query<{ id: string; botUsername: string }>(
    `SELECT id, bot_username AS "botUsername" FROM bot_connections
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
