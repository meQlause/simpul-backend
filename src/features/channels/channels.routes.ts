import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { parseChannel, parsePause } from './channels.schema.js';
import { createChannel, listChannels, pauseChannel } from './channels.service.js';
import { activateChannel, type ActivationServices } from './activation.service.js';
import { parseActivation } from './activation.schema.js';

const CREATED = 201;

export function channelsRouter(
  resolveConnection: ConnectionResolver,
  services: { newId: () => string; now: () => Date },
  activation?: ActivationServices,
) {
  const router = Router();
  router.post('/channels/:channelId/pause', async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };
    const input = parsePause(request.body, request.params.channelId);
    response.json({ data: await pauseChannel(resolveConnection, scope, input, services.now()) });
  });
  router.get('/channels', async (_request, response) => {
    const { workspaceId } = response.locals.scope as { workspaceId: string };
    response.json({ data: await listChannels(resolveConnection, workspaceId) });
  });
  router.post('/channels', async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };
    const input = parseChannel(request.body);
    response
      .status(CREATED)
      .json({ data: await createChannel(resolveConnection, scope, input, services) });
  });
  if (activation) {
    router.post('/channels/:channelId/activate', async (request, response) => {
      const scope = response.locals.scope as { workspaceId: string; actorId: string };
      const input = parseActivation(
        request.body,
        request.params.channelId,
        request.get('Idempotency-Key'),
      );
      response.json({ data: await activateChannel(resolveConnection, scope, input, activation) });
    });
  }
  return router;
}
