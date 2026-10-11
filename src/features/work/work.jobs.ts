import { z } from 'zod';
import type { PgBoss } from 'pg-boss';
import { archiveClosed } from './work-lifecycle.service.js';
import { expireTentative } from './work.service.js';

const payload = z.strictObject({ workspaceId: z.guid() });

export async function registerWorkJobs(
  queue: PgBoss,
  services: { resolveConnection: Parameters<typeof archiveClosed>[0]; now: () => Date },
) {
  await queue.work('work.lifecycle', async (jobs) => {
    for (const job of jobs) {
      const scope = payload.parse(job.data);
      const now = services.now();

      await archiveClosed(services.resolveConnection, scope.workspaceId, now);
      await expireTentative(services.resolveConnection, scope.workspaceId, now);
    }
  });
}
