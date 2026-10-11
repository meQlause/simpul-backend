import type { PoolClient } from 'pg';
import type { ConnectionResolver } from './connection-resolver.js';
import { isTenantPool } from './tenant-pool.js';
import { connectionFailed } from './connection-failure.rules.js';
import { DomainError } from '../errors/domain-error.js';

const RETRY_SECONDS = 60;

export async function transactionOnClient<Result>(
  client: PoolClient,
  workspaceId: string,
  operation: (tx: PoolClient) => Promise<Result>,
) {
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await operation(client);

    await client.query('COMMIT');

    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function scopedTransaction<Result>(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
  operation: (tx: PoolClient) => Promise<Result>,
) {
  const pool = await resolveConnection(workspaceId);
  let client: PoolClient | undefined;

  try {
    client = await pool.connect();

    return await transactionOnClient(client, workspaceId, operation);
  } catch (error) {
    if (isTenantPool(pool) && connectionFailed(error)) {
      throw new DomainError('E-DB-UNAVAILABLE', undefined, RETRY_SECONDS);
    }

    throw error;
  } finally {
    client?.release();
  }
}
