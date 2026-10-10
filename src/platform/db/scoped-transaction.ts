import type { PoolClient } from 'pg';
import type { ConnectionResolver } from './connection-resolver.js';

export async function scopedTransaction<Result>(
  resolveConnection: ConnectionResolver,
  workspaceId: string,
  operation: (tx: PoolClient) => Promise<Result>,
) {
  const pool = await resolveConnection(workspaceId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
