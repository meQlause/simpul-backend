import type { RequestHandler } from 'express';
import { DomainError } from '../errors/domain-error.js';

export const notFound: RequestHandler = (_request, _response, next) => {
  next(new DomainError('E-NOT-FOUND'));
};
