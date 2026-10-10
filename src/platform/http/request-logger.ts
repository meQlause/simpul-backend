import type { RequestHandler } from 'express';
import type { Logger } from 'pino';

export function requestLogger(logger: Logger): RequestHandler {
  return (request, response, next) => {
    const bound = logger.child({ requestId: response.getHeader('X-Request-ID') });
    const started = performance.now();
    response.locals.logger = bound;
    response.on('finish', () => {
      bound.info({
        method: request.method,
        path: request.path,
        status: response.statusCode,
        durationMilliseconds: performance.now() - started,
      });
    });
    next();
  };
}
