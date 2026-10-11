import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { routeLabel } from './delivery-routing.service.js';
import { sendNotification } from './delivery-send.service.js';
import { runStaleness } from './delivery-staleness.service.js';

type Services = Parameters<typeof routeLabel>[0] &
  Parameters<typeof sendNotification>[0] &
  Parameters<typeof runStaleness>[0];
const routingScope = z.strictObject({ workspaceId: z.guid(), labelId: z.guid() });
const sendingScope = z.strictObject({ workspaceId: z.guid(), notificationId: z.guid() });
const workspaceScope = z.strictObject({ workspaceId: z.guid() });

export async function registerDeliveryJobs(queue: PgBoss, services: Services) {
  await queue.work('delivery.gate', async (jobs) => {
    for (const job of jobs) {
      await routeLabel(services, routingScope.parse(job.data));
    }
  });
  await queue.work('delivery.send', async (jobs) => {
    for (const job of jobs) {
      await sendNotification(services, sendingScope.parse(job.data));
    }
  });
  await queue.work('delivery.staleness', async (jobs) => {
    for (const job of jobs) {
      await runStaleness(services, workspaceScope.parse(job.data));
    }
  });
}
