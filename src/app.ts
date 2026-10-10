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
import { peopleRouter } from './features/people/index.js';
import { createSecretStore } from './platform/secrets/index.js';
import { verifyMail } from './platform/mail/index.js';
import { connectionsRouter, type ConnectionSetup } from './features/connections/index.js';
import type { SetupProvider } from './platform/providers/index.js';
import { channelsRouter } from './features/channels/index.js';

type ApiServices = {
  authentication: ReturnType<typeof createAuthentication>;
  resolveConnection: ConnectionResolver;
  mail?: { masterKey: string; verifyMail?: typeof verifyMail; now: () => Date };
  telegram?: SetupProvider;
  connectionSetup?: Omit<ConnectionSetup, 'secretStore'> & { masterKey: string };
};

function mountApi(app: Express, services?: ApiServices) {
  if (services) {
    app.all('/api/auth/*splat', toNodeHandler(services.authentication));
  }
  app.use(express.json());
  if (!services) {
    return;
  }
  app.use('/api/v1', adminScope(services.authentication.resolveAdmin));
  const mail = services.mail
    ? {
        secretStore: createSecretStore(services.mail.masterKey),
        verifyMail: services.mail.verifyMail ?? verifyMail,
        now: services.mail.now,
      }
    : undefined;
  app.use('/api/v1', workspaceRouter(services.resolveConnection, mail));
  app.use('/api/v1', peopleRouter(services.resolveConnection));
  if (services.connectionSetup) {
    app.use('/api/v1', channelsRouter(services.resolveConnection, services.connectionSetup.newId));
  }
  if (services.telegram) {
    const setup = services.connectionSetup
      ? {
          ...services.connectionSetup,
          secretStore: createSecretStore(services.connectionSetup.masterKey),
        }
      : undefined;
    app.use('/api/v1', connectionsRouter(services.resolveConnection, services.telegram, setup));
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
