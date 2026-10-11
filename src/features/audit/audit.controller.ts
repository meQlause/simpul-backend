import type { RequestHandler } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { listDecisions, getDecision } from './audit-read.service.js';
import { parseDecisionId, parseDecisionQuery } from './audit-read.schema.js';

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
