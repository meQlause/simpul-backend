import type { RequestHandler } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { listDecisions, getDecision } from './audit-read.service.js';
import { parseDecisionId, parseDecisionQuery } from './audit-read.schema.js';
import { listMessages } from './audit-messages.service.js';
import { parseMessageQuery } from './audit-messages.schema.js';

export function listController(resolveConnection: ConnectionResolver): RequestHandler {
  return async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string };

    response.json(
      await listDecisions(resolveConnection, scope.workspaceId, parseDecisionQuery(request.query)),
    );
  };
}

export function detailController(resolveConnection: ConnectionResolver): RequestHandler {
  return async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string };

    response.json({
      data: await getDecision(
        resolveConnection,
        scope.workspaceId,
        parseDecisionId(request.params.decisionId),
      ),
    });
  };
}

export function messagesController(
  resolveConnection: ConnectionResolver,
  now: () => Date,
): RequestHandler {
  return async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };

    response.json(
      await listMessages(resolveConnection, scope, parseMessageQuery(request.query), now()),
    );
  };
}
