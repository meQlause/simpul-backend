import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { parseWorkQuery, parseClosure } from './work.schema.js';
import { listWork, getWork, closeWork } from './work.service.js';

type Scope = { workspaceId: string; actorId: string };

export function workRouter(resolveConnection: ConnectionResolver, now: () => Date) {
  return Router()
    .get('/work', async (request, response) => {
      const { workspaceId } = response.locals.scope as Scope;

      response.json(
        await listWork(resolveConnection, workspaceId, parseWorkQuery(request.query), now()),
      );
    })
    .get('/work/:displayId', async (request, response) => {
      const { workspaceId } = response.locals.scope as Scope;

      response.json({
        data: await getWork(resolveConnection, workspaceId, request.params.displayId, now()),
      });
    })
    .post('/work/:displayId/close', async (request, response) => {
      const scope = response.locals.scope as Scope;

      response.json({
        data: await closeWork(
          resolveConnection,
          scope,
          { ...parseClosure(request.body), displayId: request.params.displayId },
          now(),
        ),
      });
    });
}
