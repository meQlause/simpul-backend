import type { RequestHandler } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { getMe, saveSettings } from './workspace.service.js';
import { parseSettings } from './workspace.schema.js';

export function meController(resolveConnection: ConnectionResolver): RequestHandler {
  return async (_request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };
    response.json({ data: await getMe(resolveConnection, scope) });
  };
}

export function settingsController(resolveConnection: ConnectionResolver): RequestHandler {
  return async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };
    const input = parseSettings(request.body);
    response.json({ data: await saveSettings(resolveConnection, scope, input) });
  };
}
