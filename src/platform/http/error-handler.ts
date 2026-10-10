import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';
import { DomainError } from '../errors/domain-error.js';
import { ZodError } from 'zod';
import { validationError } from '../errors/validation-error.js';

function errorBody(failure: DomainError, requestId: unknown) {
  return {
    code: failure.code,
    ...(failure.message ? { message: failure.message } : {}),
    requestId,
    details: failure.details,
    ...(failure.retryAfter === undefined ? {} : { retryAfter: failure.retryAfter }),
  };
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (error instanceof ZodError) {
    error = validationError(error);
  }
  if (!(error instanceof DomainError)) {
    const logger = response.locals.logger as Logger | undefined;
    logger?.error({ errorType: error instanceof Error ? 'Error' : typeof error });
  }
  const failure = error instanceof DomainError ? error : new DomainError('E-INTERNAL');
  if (failure.retryAfter !== undefined) {
    response.setHeader('Retry-After', String(failure.retryAfter));
  }
  response.status(failure.status).json({
    error: errorBody(failure, response.getHeader('X-Request-ID')),
  });
};
