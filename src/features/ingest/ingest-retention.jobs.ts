import { z } from 'zod';
import type { PgBoss } from 'pg-boss';
import { retainMessages } from './ingest-retention.service.js';

const payload = z.strictObject({ workspaceId: z.guid() });

export async function registerRetentionJobs(
  queue: PgBoss,
  services: { resolveConnection: Parameters<typeof retainMessages>[0]; now: () => Date },
) {
  await queue.work('ingest.retention', async (jobs) => {
    for (const job of jobs) {
      await retainMessages(
        services.resolveConnection,
        payload.parse(job.data).workspaceId,
        services.now(),
      );
    }
  });
}
