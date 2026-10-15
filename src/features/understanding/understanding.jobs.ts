import type { PgBoss } from 'pg-boss';
import { queryPayload, comprehensionJobScope } from './understanding.schema.js';
import { triageUnit } from './understanding.triage.js';
import { resolveRuntimeUnit } from './understanding-runtime.service.js';
import { comprehendUnit } from './understanding.comprehension.js';
import { comprehendGenesisUnit } from './understanding-genesis.service.js';
import { comprehendGreyUnit } from './understanding-grey.service.js';
import { embedUnit } from './understanding-embed.service.js';

type Services = Parameters<typeof triageUnit>[0] &
  Parameters<typeof resolveRuntimeUnit>[0] &
  Omit<Parameters<typeof comprehendUnit>[0], 'alert'> &
  Parameters<typeof comprehendGreyUnit>[0] &
  Parameters<typeof embedUnit>[0] & { alert: (event: unknown) => void };
const workOptions = { pollingIntervalSeconds: 0.5 };

export async function registerUnderstandingJobs(queue: PgBoss, services: Services) {
  await queue.work('understanding.triage', workOptions, async (jobs) => {
    for (const job of jobs) {
      await triageUnit(services, queryPayload.parse(job.data));
    }
  });
  await queue.work('understanding.embed', workOptions, async (jobs) => {
    for (const job of jobs) {
      await embedUnit(services, queryPayload.parse(job.data));
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

// A unit with no thread goes to the grey step first: it may choose work, create work, or wait (FR-RES-02).
export async function runComprehension(
  services: Parameters<typeof comprehendGreyUnit>[0] &
    Parameters<typeof comprehendUnit>[0] &
    Parameters<typeof comprehendGenesisUnit>[0],
  scope: { workspaceId: string; unitId: string; threadId: string | null },
) {
  if (scope.threadId !== null) {
    await comprehendUnit(services, { ...scope, threadId: scope.threadId });

    return;
  }

  const next = await comprehendGreyUnit(services, {
    workspaceId: scope.workspaceId,
    unitId: scope.unitId,
  });

  if (next === 'create') {
    const retrieved = await comprehendGenesisUnit(services, scope);

    if (retrieved) {
      await decideFromSearch(services, scope, retrieved);
    }
  } else if (next !== 'done') {
    await comprehendUnit(services, { ...scope, threadId: next.threadId });
  }
}

// The genesis searched and found work: the grey step decides with what was found, and a choice of new work
// asks the genesis once more, now without any search (FR-RES-06).
async function decideFromSearch(
  services: Parameters<typeof runComprehension>[0],
  scope: { workspaceId: string; unitId: string; threadId: string | null },
  retrieved: { messageId: string; text: string }[],
) {
  const unit = { workspaceId: scope.workspaceId, unitId: scope.unitId };
  const next = await comprehendGreyUnit(services, unit, retrieved);

  if (next === 'create') {
    await comprehendGenesisUnit(services, scope, retrieved);
  } else if (next !== 'done') {
    await comprehendUnit(services, { ...scope, threadId: next.threadId });
  }
}
