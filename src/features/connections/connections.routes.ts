import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { SetupProvider } from '../../platform/providers/index.js';
import {
  parseCredential,
  parseConnection,
  parseRequestKey,
  parseReplacement,
} from './connections.schema.js';
import { verifyConnection, listConnections } from './connections.service.js';
import { createConnection, type ConnectionSetup } from './connections-create.service.js';
import { parseSession, parseSessionId } from './connections-sessions.schema.js';
import { issueSession, pollSession } from './connections-sessions.service.js';
import { rotateCredential } from './connections-credentials.service.js';

const CREATED = 201;

export function connectionsRouter(
  resolveConnection: ConnectionResolver,
  provider: SetupProvider,
  setup?: ConnectionSetup,
) {
  const router = Router();
  const verification = {
    verifyCredential: provider.verifyCredential.bind(provider),
    assertAccountAvailable: setup?.assertAccountAvailable,
  };

  router.get('/telegram/connections', async (_request, response) => {
    const { workspaceId } = response.locals.scope as { workspaceId: string };

    response.json({ data: await listConnections(resolveConnection, workspaceId) });
  });
  router.post('/telegram/connections/verify', async (request, response) => {
    const { workspaceId } = response.locals.scope as { workspaceId: string };
    const { botToken } = parseCredential(request.body);

    response.json({
      data: await verifyConnection(resolveConnection, verification, workspaceId, botToken),
    });
  });

  if (setup) {
    router.put('/telegram/connections/:connectionId/credentials', async (request, response) => {
      const scope = response.locals.scope as { workspaceId: string; actorId: string };
      const input = parseReplacement(request.body);
      const key = parseRequestKey(request.get('Idempotency-Key'));
      const connectionId = parseSessionId(request.params.connectionId);

      response.json({
        data: await rotateCredential(
          resolveConnection,
          scope,
          { input, key, connectionId },
          { ...setup, provider },
        ),
      });
    });
    router.post('/telegram/connections/:connectionId/sessions', async (request, response) => {
      const scope = response.locals.scope as { workspaceId: string; actorId: string };
      const input = {
        ...parseSession(request.body),
        connectionId: parseSessionId(request.params.connectionId),
      };

      response
        .status(CREATED)
        .json({ data: await issueSession(resolveConnection, scope, input, setup) });
    });
    router.get('/telegram/connection-sessions/:sessionId', async (request, response) => {
      const { workspaceId } = response.locals.scope as { workspaceId: string };
      const sessionId = parseSessionId(request.params.sessionId);

      response.json({
        data: await pollSession(resolveConnection, { workspaceId, sessionId }, setup.now()),
      });
    });
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
