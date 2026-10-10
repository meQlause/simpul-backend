import express, { type Express } from 'express';
import { toNodeHandler } from 'better-auth/node';
import type { createAuthentication } from './features/auth/index.js';
import type { Logger } from 'pino';
import { errorHandler } from './platform/http/error-handler.js';
import { health } from './platform/http/health.js';
import { notFound } from './platform/http/not-found.js';
import { requestId } from './platform/http/request-id.js';
import { requestLogger } from './platform/http/request-logger.js';
import { adminScope } from './platform/http/admin-scope.js';
import type { ConnectionResolver } from './platform/db/connection-resolver.js';
import { workspaceRouter } from './features/workspace/index.js';

type ApiServices = {
  authentication: ReturnType<typeof createAuthentication>;
  resolveConnection: ConnectionResolver;
};

function mountApi(app: Express, services?: ApiServices) {
  if (services) {
    app.all('/api/auth/*splat', toNodeHandler(services.authentication));
  }
  app.use(express.json());
  if (services) {
    app.use('/api/v1', adminScope(services.authentication.resolveAdmin));
    app.use('/api/v1', workspaceRouter(services.resolveConnection));
  }
}

export function createApp(
  role: string,
  checkDatabase?: () => Promise<unknown>,
  logger?: Logger,
  services?: ApiServices,
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
    mountApi(app, services);
  }
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
