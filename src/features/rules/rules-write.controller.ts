import type { RequestHandler } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { parseRuleWrite, parseRuleId } from './rules-write.schema.js';
import { saveRule } from './rules-write.service.js';

const httpOk = 200;
const httpCreated = 201;

export function ruleWriteController(
  resolveConnection: ConnectionResolver,
  now: () => Date,
  editing = false,
): RequestHandler {
  return async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };
    const ruleId = editing ? parseRuleId(request.params.ruleId) : undefined;

    const data = await saveRule(
      resolveConnection,
      { ...scope, ruleId },
      parseRuleWrite(request.body, editing),
      now(),
    );

    response.status(editing ? httpOk : httpCreated).json({ data });
  };
}
