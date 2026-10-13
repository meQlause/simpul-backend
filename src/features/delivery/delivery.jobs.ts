import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { routeLabel } from './delivery-routing.service.js';
import { sendNotification } from './delivery-send.service.js';
import { runStaleness } from './delivery-staleness.service.js';
import { runDigests } from './delivery-digest.service.js';
import { sendQuestion } from './delivery-question.service.js';

type Services = Parameters<typeof routeLabel>[0] &
  Parameters<typeof sendNotification>[0] &
  Parameters<typeof runStaleness>[0] &
  Parameters<typeof runDigests>[0] &
  Parameters<typeof sendQuestion>[0];
const routingScope = z.strictObject({ workspaceId: z.guid(), labelId: z.guid() });
const sendingScope = z.strictObject({ workspaceId: z.guid(), notificationId: z.guid() });
const workspaceScope = z.strictObject({ workspaceId: z.guid() });
const questionScope = z.strictObject({ workspaceId: z.guid(), questionId: z.guid() });
const workOptions = { pollingIntervalSeconds: 0.5 };

export async function registerDeliveryJobs(queue: PgBoss, services: Services) {
  await queue.work('delivery.gate', workOptions, async (jobs) => {
    for (const job of jobs) {
      await routeLabel(services, routingScope.parse(job.data));
    }
  });
  await queue.work('delivery.send', workOptions, async (jobs) => {
    for (const job of jobs) {
      await sendNotification(services, sendingScope.parse(job.data));
    }
  });
  await queue.work('delivery.staleness', workOptions, async (jobs) => {
    for (const job of jobs) {
      await runStaleness(services, workspaceScope.parse(job.data));
    }
  });
  await queue.work('delivery.digest', workOptions, async (jobs) => {
    for (const job of jobs) {
      await runDigests(services, workspaceScope.parse(job.data));
    }
  });
  await queue.work('delivery.question', workOptions, async (jobs) => {
    for (const job of jobs) {
      await sendQuestion(services, questionScope.parse(job.data));
    }
  });
}
