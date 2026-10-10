import { createApp } from './app.js';
import { readConfig } from './platform/config/index.js';
import { checkDatabase } from './platform/db/health.js';
import { createLogger } from './platform/logger/index.js';

const config = readConfig(process.env);

const port = 3000;
const app = createApp(
  config.PROCESS_ROLE,
  () => checkDatabase(config.DATABASE_URL),
  createLogger(config.LOG_LEVEL),
);

app.listen(port);
