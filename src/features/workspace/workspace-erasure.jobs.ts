import { z } from 'zod';
import type { PgBoss } from 'pg-boss';
import { eraseWorkspace } from './workspace-erasure.service.js';

const payload = z.strictObject({ workspaceId: z.guid() });

export async function registerErasureJobs(
  queue: PgBoss,
  resolver: Parameters<typeof eraseWorkspace>[0],
) {
  await queue.work('workspace.erase', async (jobs) => {
    for (const job of jobs) {
      await eraseWorkspace(resolver, payload.parse(job.data).workspaceId);
    }
  });
}
