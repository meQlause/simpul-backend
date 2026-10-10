import type { PoolClient } from 'pg';
import { DomainError } from '../../platform/errors/domain-error.js';
import type { parseChannel } from './channels.schema.js';

export async function insertDraft(
  tx: PoolClient,
  workspaceId: string,
  id: string,
  input: ReturnType<typeof parseChannel>,
) {
  try {
    const result = await tx.query<{ id: string }>(
      `INSERT INTO channels
       (id, workspace_id, provider, bot_connection_id, provider_chat_id, display_name, class, primary_language)
       SELECT $3, $1, connection.provider, connection.id, $4, $5, $6, $7
       FROM bot_connections AS connection WHERE connection.workspace_id = $1 AND connection.id = $2
       RETURNING id`,
      [
        workspaceId,
        input.botConnectionId,
        id,
        input.providerChatId,
        input.displayName,
        input.class,
        input.primaryLanguage,
      ],
    );
    return result.rows[0];
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === '23505' &&
      'constraint' in error &&
      error.constraint === 'channels_chat_uq'
    ) {
      throw new DomainError('E-TG-CHANNEL-DUPLICATE');
    }
    throw error;
  }
}
