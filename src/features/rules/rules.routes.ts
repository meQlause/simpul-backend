import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { listRules } from './rules.service.js';

export function rulesRouter(resolveConnection: ConnectionResolver, now: () => Date) {
  return Router().get('/rules', async (_request, response) => {
    const { workspaceId } = response.locals.scope as { workspaceId: string };

    response.json({ data: await listRules(resolveConnection, workspaceId, now()) });
  });
}
