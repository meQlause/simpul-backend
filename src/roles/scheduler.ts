import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';

export async function registerSchedulerJobs(queue: PgBoss, pool: Pool) {
  await queue.work('scheduler.tick', async () => {
    const workspaces = await pool.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');

    for (const workspace of workspaces.rows) {
      await queue.send('delivery.staleness', { workspaceId: workspace.id });
    }
  });
  await queue.schedule('scheduler.tick', '* * * * *');
}
