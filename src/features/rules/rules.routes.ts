import { Router } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { listRules, estimateRule } from './rules.service.js';
import { parseRuleEstimate } from './rules-write.schema.js';
import { ruleWriteController } from './rules-write.controller.js';

export function rulesRouter(resolveConnection: ConnectionResolver, now: () => Date) {
  return Router()
    .post('/rules/estimate', async (request, response) => {
      const { workspaceId } = response.locals.scope as { workspaceId: string };

      response.json({
        data: await estimateRule(
          resolveConnection,
          workspaceId,
          parseRuleEstimate(request.body),
          now(),
        ),
      });
    })
    .post('/rules', ruleWriteController(resolveConnection, now))
    .patch('/rules/:ruleId', ruleWriteController(resolveConnection, now, true))
    .get('/rules', async (_request, response) => {
      const { workspaceId } = response.locals.scope as { workspaceId: string };

      response.json({ data: await listRules(resolveConnection, workspaceId, now()) });
    });
}
