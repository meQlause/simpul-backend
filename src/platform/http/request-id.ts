import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

export const requestId: RequestHandler = (_request, response, next) => {
  response.setHeader('X-Request-ID', randomUUID());
  next();
};
