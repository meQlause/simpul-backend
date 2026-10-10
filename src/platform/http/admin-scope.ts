import type { RequestHandler } from 'express';
import { fromNodeHeaders } from 'better-auth/node';

type ResolveAdmin = (headers: Headers) => Promise<{ workspaceId: string; actorId: string }>;

export function adminScope(resolveAdmin: ResolveAdmin): RequestHandler {
  return async (request, response, next) => {
    response.locals.scope = await resolveAdmin(fromNodeHeaders(request.headers));
    next();
  };
}
