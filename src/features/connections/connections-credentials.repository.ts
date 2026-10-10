import type { PoolClient } from 'pg';
import type { SetupProvider } from '../../platform/providers/index.js';

export async function selectCredential(tx: PoolClient, workspaceId: string, connectionId: string) {
  const result = await tx.query<{
    id: string;
    connectionName: string;
    providerAccountId: string;
    tokenRef: string;
    webhookRef: string;
    credentialVersion: number;
    status: string;
  }>(
    `SELECT id, connection_name AS "connectionName", provider_account_id AS "providerAccountId", token_secret_ref AS "tokenRef",
     webhook_secret_ref AS "webhookRef", credential_version AS "credentialVersion", status
     FROM bot_connections WHERE workspace_id = $1 AND id = $2 AND provider = 'telegram' FOR UPDATE`,
    [workspaceId, connectionId],
  );
  return result.rows[0];
}

export async function updateCredential(
  tx: PoolClient,
  workspaceId: string,
  connectionId: string,
  input: {
    tokenRef: string;
    connectionName?: string;
    now: Date;
    account: Awaited<ReturnType<SetupProvider['verifyCredential']>>;
  },
) {
  await tx.query(
    `UPDATE bot_connections SET token_secret_ref = $3, connection_name = COALESCE($4, connection_name),
    credential_version = credential_version + 1, verified_at = $5, webhook_checked_at = $5,
    bot_username = $6, bot_name = $7, status = $8 WHERE workspace_id = $1 AND id = $2`,
    [
      workspaceId,
      connectionId,
      input.tokenRef,
      input.connectionName,
      input.now,
      input.account.botUsername,
      input.account.botName,
      input.account.privacyModeOk ? 'ready' : 'needs_action',
    ],
  );
}

export async function degradeConnection(tx: PoolClient, workspaceId: string, connectionId: string) {
  await tx.query(
    "UPDATE bot_connections SET status = 'degraded' WHERE workspace_id = $1 AND id = $2",
    [workspaceId, connectionId],
  );
}
