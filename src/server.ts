import { readConfig } from './platform/config/index.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { checkDatabase } from './platform/db/health.js';
import { createLogger } from './platform/logger/index.js';
import { createSystemPool } from './platform/db/index.js';
import { createConnectionResolver } from './platform/db/connection-resolver.js';
import { createTelegramProvider } from './platform/providers/index.js';

const config = readConfig(process.env);

const port = 3000;
const WEBHOOK_SECRET_BYTES = 32;
const commandArgumentsOffset = 3;

if (process.argv[2] === 'create-workspace') {
  const { runCreateWorkspace } = await import('./roles/create-workspace.js');
  await runCreateWorkspace(config, process.argv.slice(commandArgumentsOffset));
} else {
  const { createApp } = await import('./app.js');
  const { createAuthentication } = await import('./features/auth/index.js');
  const pool = config.PROCESS_ROLE === 'api' ? createSystemPool(config.DATABASE_URL) : undefined;
  const services = pool
    ? {
        authentication: createAuthentication(pool, {
          baseUrl: config.PUBLIC_BASE_URL,
          secret: config.AUTH_SECRET,
        }),
        resolveConnection: createConnectionResolver(pool),
        mail: { masterKey: config.SECRETS_MASTER_KEY, now: () => new Date() },
        telegram: createTelegramProvider(config.TELEGRAM_API_BASE),
        connectionSetup: {
          masterKey: config.SECRETS_MASTER_KEY,
          publicBaseUrl: config.PUBLIC_BASE_URL,
          now: () => new Date(),
          newId: randomUUID,
          newWebhookSecret: () => randomBytes(WEBHOOK_SECRET_BYTES).toString('base64url'),
        },
      }
    : undefined;
  const app = createApp(
    config.PROCESS_ROLE,
    () => checkDatabase(config.DATABASE_URL),
    createLogger(config.LOG_LEVEL),
    services,
  );
  app.listen(port);
}
