import type { PgBoss } from 'pg-boss';
import { z as schema } from 'zod';
import { coalesce, type CoalesceServices } from './ingest.coalesce.service.js';

const coalescePayload = schema
  .object({
    workspaceId: schema.guid(),
    channelId: schema.guid(),
    senderExternalId: schema.string().min(1),
  })
  .strict();

export async function registerIngestJobs(queue: PgBoss, services: CoalesceServices) {
  await queue.work('ingest.coalesce', async (jobs) => {
    for (const job of jobs) {
      await coalesce(services, coalescePayload.parse(job.data));
    }
  });
}
