import type { PgBoss } from 'pg-boss';
import { z as schema } from 'zod';
import { coalesce, type CoalesceServices } from './ingest.coalesce.service.js';
import { processMedia } from './ingest.media.service.js';
import { answerStartUpdate } from './ingest.start.service.js';

const workOptions = { pollingIntervalSeconds: 0.5 };
const coalescePayload = schema
  .object({
    workspaceId: schema.guid(),
    channelId: schema.guid(),
    senderExternalId: schema.string().min(1),
  })
  .strict();

export async function registerIngestJobs(queue: PgBoss, services: CoalesceServices) {
  await queue.work('ingest.coalesce', workOptions, async (jobs) => {
    for (const job of jobs) {
      await coalesce(services, coalescePayload.parse(job.data));
    }
  });
}

export async function registerMediaJobs(
  queue: PgBoss,
  services: Parameters<typeof processMedia>[0],
) {
  await queue.work('ingest.media', workOptions, async (jobs) => {
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

const startPayload = schema.strictObject({
  workspaceId: schema.guid(),
  connectionId: schema.guid(),
  chatId: schema.string().min(1),
  senderExternalId: schema.string().min(1),
  senderHandle: schema.string().min(1).optional(),
  codeHash: schema
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
});

export async function registerStartJobs(
  queue: PgBoss,
  services: Parameters<typeof answerStartUpdate>[0],
) {
  await queue.work('ingest.start', workOptions, async (jobs) => {
    for (const job of jobs) {
      await answerStartUpdate(services, startPayload.parse(job.data));
    }
  });
}
