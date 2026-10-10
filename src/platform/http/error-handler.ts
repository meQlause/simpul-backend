import type { ErrorRequestHandler } from 'express';
import { DomainError } from '../errors/domain-error.js';

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  const failure = error instanceof DomainError ? error : new DomainError('E-INTERNAL');
  response.status(failure.status).json({
    error: {
      code: failure.code,
      message: failure.message,
      requestId: response.getHeader('X-Request-ID'),
    },
  });
};
