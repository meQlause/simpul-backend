import type { RequestHandler } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { DomainError } from '../errors/domain-error.js';

type ResolveAdmin = (headers: Headers) => Promise<{
  workspaceId: string;
  actorId: string;
  databaseSetupRequired?: boolean;
}>;

export function adminScope(resolveAdmin: ResolveAdmin): RequestHandler {
  return async (request, response, next) => {
    response.locals.scope = await resolveAdmin(fromNodeHeaders(request.headers));
    const setupRoute = request.path === '/database' && ['GET', 'PUT'].includes(request.method);

    if (response.locals.scope.databaseSetupRequired && !setupRoute) {
      throw new DomainError('E-DB-SETUP-REQUIRED');
    }

    next();
  };
}
