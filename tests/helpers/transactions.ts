import type { Pool, PoolClient } from 'pg';
import { afterEach, beforeEach } from 'vitest';

export function transactionFixture(pool: Pool) {
  let client: PoolClient;

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });
  afterEach(async () => {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  return () => client;
}
