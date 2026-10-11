import type { PgBoss } from 'pg-boss';
import { z as schema } from 'zod';
import { coalesce, type CoalesceServices } from './ingest.coalesce.service.js';
import { processMedia } from './ingest.media.service.js';

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

export async function registerMediaJobs(
  queue: PgBoss,
  services: Parameters<typeof processMedia>[0],
) {
  await queue.work('ingest.media', async (jobs) => {
    for (const job of jobs) {
      await processMedia(
        services,
        schema
          .strictObject({ workspaceId: schema.guid(), messageId: schema.guid() })
          .parse(job.data),
      );
    }
  });
}
