import type { RequestHandler } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { getMe } from './workspace.service.js';

export function meController(resolveConnection: ConnectionResolver): RequestHandler {
  return async (_request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };
    response.json({ data: await getMe(resolveConnection, scope) });
  };
}
