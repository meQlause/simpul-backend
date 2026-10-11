import { verifyChannel } from './channels-verify.service.js';
import { parseChannelVerification } from './channels-verify.schema.js';
import { editChannel } from './channels-edit.service.js';
import { parseChannelEdit } from './channels-edit.schema.js';
import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { parseChannel, parsePause, parseChannelId } from './channels.schema.js';
import { createChannel, listChannels, pauseChannel, getChannel } from './channels.service.js';
import { activateChannel, type ActivationServices } from './activation.service.js';
import { parseActivation } from './activation.schema.js';

const CREATED = 201;

export function channelsRouter(
  resolveConnection: ConnectionResolver,
  services: { newId: () => string; now: () => Date },
  activation?: ActivationServices,
) {
  const router = Router();

  router.patch('/channels/:channelId', async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };
    const input = parseChannelEdit(request.body, request.params.channelId);

    response.json({ data: await editChannel(resolveConnection, scope, input, services.now()) });
  });
  router.get('/channels/:channelId', async (request, response) => {
    const { workspaceId } = response.locals.scope as { workspaceId: string };
    const channelId = parseChannelId(request.params.channelId);

    response.json({ data: await getChannel(resolveConnection, workspaceId, channelId) });
  });
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
    router.post('/channels/:channelId/verify', async (request, response) => {
      const scope = response.locals.scope as { workspaceId: string; actorId: string };
      const channelId = parseChannelVerification(request.body, request.params.channelId);

      response.json({
        data: await verifyChannel(resolveConnection, scope, channelId, {
          ...activation,
          newId: services.newId,
        }),
      });
    });
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
