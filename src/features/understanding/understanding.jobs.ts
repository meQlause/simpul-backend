import type { PgBoss } from 'pg-boss';
import { queryPayload, comprehensionJobScope } from './understanding.schema.js';
import { triageUnit } from './understanding.triage.js';
import { resolveRuntimeUnit } from './understanding-runtime.service.js';
import { comprehendUnit } from './understanding.comprehension.js';
import { comprehendGenesisUnit } from './understanding-genesis.service.js';

type Services = Parameters<typeof triageUnit>[0] &
  Parameters<typeof resolveRuntimeUnit>[0] &
  Omit<Parameters<typeof comprehendUnit>[0], 'alert'> & { alert: (event: unknown) => void };
const workOptions = { pollingIntervalSeconds: 0.5 };

export async function registerUnderstandingJobs(queue: PgBoss, services: Services) {
  await queue.work('understanding.triage', workOptions, async (jobs) => {
    for (const job of jobs) {
      await triageUnit(services, queryPayload.parse(job.data));
    }
  });
  await queue.work('understanding.resolve', workOptions, async (jobs) => {
    for (const job of jobs) {
      await resolveRuntimeUnit(services, queryPayload.parse(job.data));
    }
  });
  await queue.work('understanding.comprehend', workOptions, async (jobs) => {
    for (const job of jobs) {
      await runComprehension(services, comprehensionJobScope.parse(job.data));
    }
  });
}

async function runComprehension(
  services: Services,
  scope: { workspaceId: string; unitId: string; threadId: string | null },
) {
  if (scope.threadId === null) {
    await comprehendGenesisUnit(services, scope);
  } else {
    await comprehendUnit(services, { ...scope, threadId: scope.threadId });
  }
}
