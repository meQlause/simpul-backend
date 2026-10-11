import type { RequestHandler } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { parseOnboarding } from './workspace-onboarding.schema.js';
import { completeOnboarding } from './workspace-onboarding.service.js';

export function onboardingController(
  resolveConnection: ConnectionResolver,
  now: () => Date,
): RequestHandler {
  return async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };

    response.json({
      data: await completeOnboarding(
        resolveConnection,
        scope,
        parseOnboarding(request.body),
        now(),
      ),
    });
  };
}
