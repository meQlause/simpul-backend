import type { PoolClient } from 'pg';

export type SessionRow = {
  id: string;
  expires_at: Date;
  consumed_at: Date | null;
  candidate_chat_id: string | null;
  candidate_title: string | null;
  candidate_chat_type: string | null;
};

export async function insertSession(
  tx: PoolClient,
  scope: { workspaceId: string; actorId: string },
  input: {
    id: string;
    connectionId: string;
    codeHash: Buffer;
    purpose: string;
    now: Date;
    expiresAt: Date;
  },
) {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO channel_connection_sessions
     (id, workspace_id, bot_connection_id, created_by, code_hash, purpose, created_at, expires_at)
     SELECT $3, $1, connection.id, $4, $5, $6, $7, $8 FROM bot_connections AS connection
     WHERE connection.workspace_id = $1 AND connection.id = $2 RETURNING id`,
    [
      scope.workspaceId,
      input.connectionId,
      input.id,
      scope.actorId,
      input.codeHash,
      input.purpose,
      input.now,
      input.expiresAt,
    ],
  );
  return result.rows[0];
}

export async function selectSession(tx: PoolClient, workspaceId: string, sessionId: string) {
  const result = await tx.query<SessionRow>(
    `SELECT id, expires_at, consumed_at, candidate_chat_id, candidate_title, candidate_chat_type
     FROM channel_connection_sessions WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, sessionId],
  );
  return result.rows[0];
}

export async function identifySession(
  tx: PoolClient,
  input: {
    workspaceId: string;
    connectionId: string;
    codeHash: Buffer;
    now: Date;
    chatId: string;
    title: string;
    chatType: string;
  },
) {
  await tx.query(
    `UPDATE channel_connection_sessions SET candidate_chat_id = $4, candidate_title = $5, candidate_chat_type = $6
     WHERE workspace_id = $1 AND bot_connection_id = $2 AND code_hash = $3
       AND purpose = 'identify_group' AND expires_at > $7 AND consumed_at IS NULL AND candidate_chat_id IS NULL`,
    [
      input.workspaceId,
      input.connectionId,
      input.codeHash,
      input.chatId,
      input.title,
      input.chatType,
      input.now,
    ],
  );
}

export async function consumeSession(
  tx: PoolClient,
  workspaceId: string,
  input: { sessionId: string; connectionId: string; now: Date },
) {
  const result = await tx.query<{
    chatId: string;
    title: string;
    chatType: 'group' | 'supergroup';
  }>(
    `UPDATE channel_connection_sessions SET consumed_at = $4
     WHERE workspace_id = $1 AND id = $2 AND bot_connection_id = $3
       AND purpose = 'identify_group' AND expires_at > $4 AND consumed_at IS NULL AND candidate_chat_id IS NOT NULL
     RETURNING candidate_chat_id AS "chatId", candidate_title AS title, candidate_chat_type AS "chatType"`,
    [workspaceId, input.sessionId, input.connectionId, input.now],
  );
  return result.rows[0];
}
