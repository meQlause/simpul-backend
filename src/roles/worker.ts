import type { PgBoss } from 'pg-boss';
import type { ConnectionResolver } from '../platform/db/connection-resolver.js';
import type { ModelPort } from '../platform/llm/port.js';
import type { createSecretStore } from '../platform/secrets/index.js';
import type { createProviderRegistry } from '../platform/providers/index.js';
import { registerIngestJobs } from '../features/ingest/index.js';
import { registerUnderstandingJobs } from '../features/understanding/index.js';
import { registerDeliveryJobs } from '../features/delivery/index.js';
import {
  publishUnit,
  publishResolution,
  publishMatching,
  publishComprehension,
  publishNotification,
} from '../platform/queue/index.js';

export type PipelineServices = {
  resolveConnection: ConnectionResolver;
  model: ModelPort;
  now: () => Date;
  secretStore: ReturnType<typeof createSecretStore>;
  providers: ReturnType<typeof createProviderRegistry>;
  publicBaseUrl: string;
  debounceSeconds: number;
  alert: (event: unknown) => void;
  audit: (event: unknown) => void;
};

export async function registerPipelineJobs(queue: PgBoss, services: PipelineServices) {
  await registerIngestJobs(queue, { ...services, publishUnit: publishUnit(queue) });
  await registerUnderstandingJobs(queue, {
    ...services,
    publishResolve: publishResolution(queue),
    publishComprehend: publishComprehension(queue),
    publishMatcher: publishMatching(queue),
  });
  await registerDeliveryJobs(queue, {
    ...services,
    publishNotification: publishNotification(queue),
  });
}
