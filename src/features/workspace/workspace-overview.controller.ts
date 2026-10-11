import type { RequestHandler } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { parseOverviewQuery } from './workspace.schema.js';
import { getOverview } from './workspace-overview.service.js';

export function overviewController(
  resolveConnection: ConnectionResolver,
  now: () => Date,
): RequestHandler {
  return async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string };
    const { period } = parseOverviewQuery(request.query);

    response.json({ data: await getOverview(resolveConnection, scope.workspaceId, period, now()) });
  };
}
