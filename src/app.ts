import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import type { createAuthentication } from './features/auth/index.js';
import type { Logger } from 'pino';
import { errorHandler } from './platform/http/error-handler.js';
import { health } from './platform/http/health.js';
import { notFound } from './platform/http/not-found.js';
import { requestId } from './platform/http/request-id.js';
import { requestLogger } from './platform/http/request-logger.js';

export function createApp(
  role: string,
  checkDatabase?: () => Promise<unknown>,
  logger?: Logger,
  authentication?: ReturnType<typeof createAuthentication>,
) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  if (logger) {
    app.use(requestLogger(logger));
  }
  if (checkDatabase) {
    app.get('/health', health(checkDatabase));
  }
  if (role === 'api') {
    if (authentication) {
      app.all('/api/auth/*splat', toNodeHandler(authentication));
    }
    app.use(express.json());
  }
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
