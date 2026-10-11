import type { RequestHandler } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { getMail, saveMail, type MailServices } from './workspace-mail.service.js';
import { parseMail } from './workspace-mail.schema.js';

export function mailController(resolveConnection: ConnectionResolver): RequestHandler {
  return async (_request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };

    response.json(await getMail(resolveConnection, scope.workspaceId));
  };
}

export function saveMailController(
  resolveConnection: ConnectionResolver,
  services: MailServices,
): RequestHandler {
  return async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };

    response.json({
      data: await saveMail(resolveConnection, scope, parseMail(request.body), services),
    });
  };
}
