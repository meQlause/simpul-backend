import type { PoolClient } from 'pg';
import { DomainError } from '../../platform/errors/domain-error.js';
import type { SetupProvider } from '../../platform/providers/index.js';

export async function storedAccount(tx: PoolClient, workspaceId: string) {
  const result = await tx.query<{ provider_account_id: string }>(
    "SELECT provider_account_id FROM bot_connections WHERE workspace_id = $1 AND provider = 'telegram'",
    [workspaceId],
  );
  return result.rows[0]?.provider_account_id;
}

export async function insertConnection(
  tx: PoolClient,
  scope: { workspaceId: string; actorId: string },
  input: {
    id: string;
    connectionName: string;
    tokenRef: string;
    webhookRef: string;
    verifiedAt: Date;
    account: Awaited<ReturnType<SetupProvider['verifyCredential']>>;
  },
) {
  const { id, connectionName, tokenRef, webhookRef, verifiedAt, account } = input;
  try {
    await tx.query(
      `INSERT INTO bot_connections
      (id, workspace_id, provider, connection_name, provider_account_id, bot_username, bot_name,
       token_secret_ref, webhook_secret_ref, status, verified_at, webhook_checked_at, created_by)
      VALUES ($1, $2, 'telegram', $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)`,
      [
        id,
        scope.workspaceId,
        connectionName,
        account.providerAccountId,
        account.botUsername,
        account.botName,
        tokenRef,
        webhookRef,
        account.privacyModeOk ? 'ready' : 'needs_action',
        verifiedAt,
        scope.actorId,
      ],
    );
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === '23505' &&
      'constraint' in error &&
      ['bot_account_uq', 'bot_ws_provider_uq'].includes(String(error.constraint))
    ) {
      throw new DomainError('E-TG-BOT-IN-USE');
    }
    throw error;
  }
}
