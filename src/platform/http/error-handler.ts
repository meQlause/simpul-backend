import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';
import { DomainError } from '../errors/domain-error.js';

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (!(error instanceof DomainError)) {
    const logger = response.locals.logger as Logger | undefined;
    logger?.error({ errorType: error instanceof Error ? error.name : typeof error });
  }
  const failure = error instanceof DomainError ? error : new DomainError('E-INTERNAL');
  response.status(failure.status).json({
    error: {
      code: failure.code,
      message: failure.message,
      requestId: response.getHeader('X-Request-ID'),
    },
  });
};
