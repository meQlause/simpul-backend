import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { parseWorkQuery } from './work.schema.js';
import { listWork } from './work.service.js';

export function workRouter(resolveConnection: ConnectionResolver, now: () => Date) {
  return Router().get('/work', async (request, response) => {
    const { workspaceId } = response.locals.scope as { workspaceId: string };
    const input = parseWorkQuery(request.query);

    response.json(await listWork(resolveConnection, workspaceId, input, now()));
  });
}
