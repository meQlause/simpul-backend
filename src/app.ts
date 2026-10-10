import express from 'express';
import { errorHandler } from './platform/http/error-handler.js';
import { notFound } from './platform/http/not-found.js';
import { requestId } from './platform/http/request-id.js';

export function createApp(role: string) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  if (role === 'api') {
    app.use(express.json());
  }
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
