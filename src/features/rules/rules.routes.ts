import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { listRules } from './rules.service.js';
import { ruleWriteController } from './rules-write.controller.js';

export function rulesRouter(resolveConnection: ConnectionResolver, now: () => Date) {
  return Router()
    .post('/rules', ruleWriteController(resolveConnection, now))
    .patch('/rules/:ruleId', ruleWriteController(resolveConnection, now, true))
    .get('/rules', async (_request, response) => {
      const { workspaceId } = response.locals.scope as { workspaceId: string };

      response.json({ data: await listRules(resolveConnection, workspaceId, now()) });
    });
}
