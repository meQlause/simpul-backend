import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { SetupProvider } from '../../platform/providers/index.js';
import { parseCredential, parseConnection, parseRequestKey } from './connections.schema.js';
import { verifyConnection, listConnections } from './connections.service.js';
import { createConnection, type ConnectionSetup } from './connections-create.service.js';

const CREATED = 201;

export function connectionsRouter(
  resolveConnection: ConnectionResolver,
  provider: SetupProvider,
  setup?: ConnectionSetup,
) {
  const router = Router();
  router.get('/telegram/connections', async (_request, response) => {
    const { workspaceId } = response.locals.scope as { workspaceId: string };
    response.json({ data: await listConnections(resolveConnection, workspaceId) });
  });
  router.post('/telegram/connections/verify', async (request, response) => {
    const { workspaceId } = response.locals.scope as { workspaceId: string };
    const { botToken } = parseCredential(request.body);
    response.json({
      data: await verifyConnection(resolveConnection, provider, workspaceId, botToken),
    });
  });
  if (setup) {
    router.post('/telegram/connections', async (request, response) => {
      const scope = response.locals.scope as { workspaceId: string; actorId: string };
      const input = parseConnection(request.body);
      const key = parseRequestKey(request.get('Idempotency-Key'));
      response.status(CREATED).json({
        data: await createConnection(
          resolveConnection,
          scope,
          { input, key },
          { ...setup, provider },
        ),
      });
    });
  }
  return router;
}
