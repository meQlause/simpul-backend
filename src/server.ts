import { readConfig } from './platform/config/index.js';
import { checkDatabase } from './platform/db/health.js';
import { createLogger } from './platform/logger/index.js';
import { createSystemPool } from './platform/db/index.js';

const config = readConfig(process.env);

const port = 3000;
const commandArgumentsOffset = 3;

if (process.argv[2] === 'create-workspace') {
  const { runCreateWorkspace } = await import('./roles/create-workspace.js');
  await runCreateWorkspace(config, process.argv.slice(commandArgumentsOffset));
} else {
  const { createApp } = await import('./app.js');
  const { createAuthentication } = await import('./features/auth/index.js');
  const authentication =
    config.PROCESS_ROLE === 'api'
      ? createAuthentication(createSystemPool(config.DATABASE_URL), {
          baseUrl: config.PUBLIC_BASE_URL,
          secret: config.AUTH_SECRET,
        })
      : undefined;
  const app = createApp(
    config.PROCESS_ROLE,
    () => checkDatabase(config.DATABASE_URL),
    createLogger(config.LOG_LEVEL),
    authentication,
  );
  app.listen(port);
}
