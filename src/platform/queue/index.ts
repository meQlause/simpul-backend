import { PgBoss } from 'pg-boss';
import type { Pool, PoolClient } from 'pg';

export async function createQueue(pool: Pool) {
  const boss = new PgBoss({
    db: { executeSql: (text, values) => pool.query(text, values) },
    schedule: false,
    supervise: false,
  });

  await boss.start();
  await boss.createQueue('ingest.coalesce', { retryLimit: 5, retryBackoff: true });

  return boss;
}

export function publishCoalesce(boss: PgBoss) {
  return (
    tx: PoolClient,
    payload: { workspaceId: string; channelId: string; senderExternalId: string },
  ) =>
    boss.send('ingest.coalesce', payload, {
      startAfter: 12,
      db: { executeSql: (text, values) => tx.query(text, values) },
    });
}
