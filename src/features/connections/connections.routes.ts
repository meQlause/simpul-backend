import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { CredentialProvider } from '../../platform/providers/index.js';
import { parseCredential } from './connections.schema.js';
import { verifyConnection } from './connections.service.js';

export function connectionsRouter(
  resolveConnection: ConnectionResolver,
  provider: CredentialProvider,
) {
  const router = Router();
  router.post('/telegram/connections/verify', async (request, response) => {
    const { workspaceId } = response.locals.scope as { workspaceId: string };
    const { botToken } = parseCredential(request.body);
    response.json({
      data: await verifyConnection(resolveConnection, provider, workspaceId, botToken),
    });
  });
  return router;
}
