import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { parseChannel } from './channels.schema.js';
import { createChannel } from './channels.service.js';

const CREATED = 201;

export function channelsRouter(
  resolveConnection: ConnectionResolver,
  services: { newId: () => string; now: () => Date },
) {
  const router = Router();
  router.post('/channels', async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };
    const input = parseChannel(request.body);
    response
      .status(CREATED)
      .json({ data: await createChannel(resolveConnection, scope, input, services) });
  });
  return router;
}
