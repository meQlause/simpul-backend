import type { RequestHandler } from 'express';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';
import { listReview, getReview, resolveReview } from './review-queue.service.js';
import { parseReviewQuery, parseReviewId, parseReviewBody } from './review-queue.schema.js';
import type { ReviewServices } from './review-queue.service.js';

export function listController(resolveConnection: ConnectionResolver): RequestHandler {
  return async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string };

    response.json(
      await listReview(resolveConnection, scope.workspaceId, parseReviewQuery(request.query)),
    );
  };
}

export function itemController(resolveConnection: ConnectionResolver): RequestHandler {
  return async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string };

    response.json({
      data: await getReview(
        resolveConnection,
        scope.workspaceId,
        parseReviewId(request.params.itemId),
      ),
    });
  };
}

export function resolveController(
  resolveConnection: ConnectionResolver,
  services: ReviewServices,
): RequestHandler {
  return async (request, response) => {
    const scope = response.locals.scope as { workspaceId: string; actorId: string };

    response.json({
      data: await resolveReview(
        { resolveConnection, ...services },
        scope,
        parseReviewId(request.params.itemId),
        parseReviewBody(request.body),
      ),
    });
  };
}
