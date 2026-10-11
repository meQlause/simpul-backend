import {
  createQueue,
  publishCoalesce,
  publishMatching,
  publishNotification,
} from './platform/queue/index.js';
import { readConfig } from './platform/config/index.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { checkDatabase } from './platform/db/health.js';
import { createLogger } from './platform/logger/index.js';
import { createSystemPool } from './platform/db/index.js';
import { createConnectionResolver } from './platform/db/connection-resolver.js';
import { createProviderRegistry } from './platform/providers/index.js';
import { createTelegramProvider } from './platform/providers/telegram/index.js';
import { createConnectionLookup } from './platform/db/connection-lookup.js';
import { createSecretStore } from './platform/secrets/index.js';

const config = readConfig(process.env);

const port = 3000;
const WEBHOOK_SECRET_BYTES = 32;
const CONNECTION_CODE_BYTES = 16;
const commandArgumentsOffset = 3;

if (process.argv[2] === 'create-workspace') {
  const { runCreateWorkspace } = await import('./roles/create-workspace.js');

  await runCreateWorkspace(config, process.argv.slice(commandArgumentsOffset));
} else {
  const pool = createSystemPool(config.DATABASE_URL);
  const providers = createProviderRegistry();

  providers.register(
    createTelegramProvider(config.TELEGRAM_API_BASE, undefined, {
      callTimeoutMs: config.TELEGRAM_CALL_TIMEOUT_MS,
      sendPerSecond: config.TELEGRAM_SEND_PER_SECOND,
      sendPerChatPerMinute: config.TELEGRAM_SEND_PER_CHAT_PER_MINUTE,
    }),
  );

  try {
    const inventory = await pool.query<{ provider: string }>(
      'SELECT provider FROM providers_in_use()',
    );

    providers.assertCovers(inventory.rows.map((row) => row.provider));
  } catch (error) {
    await pool.end();
    throw error;
  }

  const queuePool = ['api', 'webhook', 'worker', 'scheduler'].includes(config.PROCESS_ROLE)
    ? createSystemPool(config.DATABASE_QUEUE_URL)
    : undefined;
  const queue = queuePool
    ? await createQueue(queuePool, config.PROCESS_ROLE === 'scheduler')
    : undefined;

  const { createApp } = await import('./app.js');
  const { createAuthentication } = await import('./features/auth/index.js');
  const services = ['api', 'webhook'].includes(config.PROCESS_ROLE)
    ? {
        authentication: createAuthentication(pool, {
          baseUrl: config.PUBLIC_BASE_URL,
          secret: config.AUTH_SECRET,
        }),
        resolveConnection: createConnectionResolver(pool),
        review: {
          now: () => new Date(),
          publishMatcher: queue ? publishMatching(queue) : undefined,
        },
        webhook: {
          resolveConnection: createConnectionResolver(pool),
          lookupConnection: createConnectionLookup(pool),
          secretStore: createSecretStore(config.SECRETS_MASTER_KEY),
          providers,
          now: () => new Date(),
          publish: queue ? publishCoalesce(queue, config.INGEST_DEBOUNCE_SECONDS) : undefined,
          publishNotification: queue ? publishNotification(queue) : undefined,
        },
        mail: { masterKey: config.SECRETS_MASTER_KEY, now: () => new Date() },
        telegram: providers.adapterFor('telegram'),
        connectionSetup: {
          masterKey: config.SECRETS_MASTER_KEY,
          publicBaseUrl: config.PUBLIC_BASE_URL,
          now: () => new Date(),
          newId: randomUUID,
          newWebhookSecret: () => randomBytes(WEBHOOK_SECRET_BYTES).toString('base64url'),
          newCode: () => randomBytes(CONNECTION_CODE_BYTES).toString('hex'),
        },
      }
    : undefined;

  if (queue && config.PROCESS_ROLE === 'worker') {
    const { registerPipelineJobs } = await import('./roles/worker.js');
    const { createGeminiModel } = await import('./platform/llm/gemini.js');
    const logger = createLogger(config.LOG_LEVEL);

    await registerPipelineJobs(queue, {
      resolveConnection: createConnectionResolver(pool),
      now: () => new Date(),
      debounceSeconds: config.INGEST_DEBOUNCE_SECONDS,
      providers,
      secretStore: createSecretStore(config.SECRETS_MASTER_KEY),
      publicBaseUrl: config.PUBLIC_BASE_URL,
      model: createGeminiModel({
        apiKey: config.GEMINI_API_KEY,
        models: {
          triage: config.GEMINI_MODEL_TRIAGE,
          standard: config.GEMINI_MODEL_STANDARD,
          strong: config.GEMINI_MODEL_STRONG,
        },
      }),
      audit: (event) => logger.warn(event, 'Pipeline injection screen'),
      alert: (event) => logger.error(event, 'Pipeline operator alert'),
    });
  }

  if (queue && config.PROCESS_ROLE === 'scheduler') {
    const { registerSchedulerJobs } = await import('./roles/scheduler.js');

    await registerSchedulerJobs(queue, pool);
  }

  if (!services && !['worker', 'scheduler'].includes(config.PROCESS_ROLE)) {
    await pool.end();
  }

  const app = createApp(
    config.PROCESS_ROLE,
    () => checkDatabase(config.DATABASE_URL),
    createLogger(config.LOG_LEVEL),
    services,
  );

  app.listen(port);
}
