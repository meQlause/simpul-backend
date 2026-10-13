import type { PgBoss } from 'pg-boss';
import type { ConnectionResolver } from '../platform/db/connection-resolver.js';
import type { ModelPort } from '../platform/llm/port.js';
import type { createSecretStore } from '../platform/secrets/index.js';
import type { createProviderRegistry } from '../platform/providers/index.js';
import {
  registerIngestJobs,
  registerMediaJobs,
  registerRetentionJobs,
} from '../features/ingest/index.js';
import { registerUnderstandingJobs } from '../features/understanding/index.js';
import { registerDeliveryJobs } from '../features/delivery/index.js';
import { registerWorkJobs } from '../features/work/index.js';
import { registerErasureJobs } from '../features/workspace/index.js';
import {
  publishUnit,
  publishResolution,
  publishMatching,
  publishComprehension,
  publishNotification,
  publishQuestion,
} from '../platform/queue/index.js';

export type PipelineServices = {
  resolveConnection: ConnectionResolver;
  model: ModelPort;
  transcriber: { transcribe: (audio: { data: Uint8Array; mimeType: string }) => Promise<string> };
  now: () => Date;
  secretStore: ReturnType<typeof createSecretStore>;
  providers: ReturnType<typeof createProviderRegistry>;
  publicBaseUrl: string;
  debounceSeconds: number;
  alert: (event: unknown) => void;
  audit: (event: unknown) => void;
};

export async function registerPipelineJobs(queue: PgBoss, services: PipelineServices) {
  await registerWorkJobs(queue, services);
  await registerErasureJobs(queue, services.resolveConnection);
  await registerRetentionJobs(queue, services);
  await registerIngestJobs(queue, { ...services, publishUnit: publishUnit(queue) });
  await registerMediaJobs(queue, { ...services, publishUnit: publishUnit(queue) });
  await registerUnderstandingJobs(queue, {
    ...services,
    publishResolve: publishResolution(queue),
    publishComprehend: publishComprehension(queue),
    publishMatcher: publishMatching(queue),
    publishQuestion: publishQuestion(queue),
  });
  await registerDeliveryJobs(queue, {
    ...services,
    publishNotification: publishNotification(queue),
  });
}
