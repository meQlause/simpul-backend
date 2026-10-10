import { createApp } from './app.js';
import { readConfig } from './platform/config/index.js';
import { checkDatabase } from './platform/db/health.js';
import { createLogger } from './platform/logger/index.js';
import { runCreateWorkspace } from './roles/create-workspace.js';
import { createSystemPool } from './platform/db/index.js';
import { createAuthentication } from './features/auth/index.js';

const config = readConfig(process.env);

const port = 3000;
const commandArgumentsOffset = 3;

if (process.argv[2] === 'create-workspace') {
  await runCreateWorkspace(config, process.argv.slice(commandArgumentsOffset));
} else {
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
