import {
  createQueue,
  publishCoalesce,
  publishComprehension,
  publishMatching,
  publishNotification,
  publishMedia,
  publishStart,
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
import { ownDatabaseQueues } from './platform/db/own-database-queues.js';
import { createAccountClaims } from './platform/db/connection-claims.js';
import { createSystemMailer } from './platform/mail/system.js';
import { createMetricSink } from './platform/metrics/index.js';

const config = readConfig(process.env);

const WEBHOOK_SECRET_BYTES = 32;
const CONNECTION_CODE_BYTES = 16;
const commandArgumentsOffset = 3;
const TENANT_APPLICATION_CONNECTIONS = 3;
const TENANT_REQUEST_CONNECTIONS = 5;

if (process.argv[2] === 'create-workspace') {
  const { runCreateWorkspace } = await import('./roles/create-workspace.js');

  await runCreateWorkspace(config, process.argv.slice(commandArgumentsOffset));
} else if (process.argv[2] === 'migrate-databases') {
  const { runMigrations } = await import('./roles/migrate-command.js');

  await runMigrations(config);
} else if (process.argv[2] === 'backfill-embeddings') {
  const { runBackfillEmbeddings } = await import('./roles/backfill-embeddings.js');

  await runBackfillEmbeddings(config);
} else {
  const pool = createSystemPool(config.DATABASE_URL);
  const emit = createMetricSink(createLogger(config.LOG_LEVEL));
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
  const tenantOptions = {
    emit,
    systemHost: new URL(config.DATABASE_URL).hostname,
    secretStore: createSecretStore(config.SECRETS_MASTER_KEY),
  };
  const resolveConnection = createConnectionResolver(pool, {
    ...tenantOptions,
    maxConnections: ['worker', 'scheduler'].includes(config.PROCESS_ROLE)
      ? TENANT_APPLICATION_CONNECTIONS
      : TENANT_REQUEST_CONNECTIONS,
  });
  const { createGeminiModel } = await import('./platform/llm/gemini.js');
  const services = ['api', 'webhook'].includes(config.PROCESS_ROLE)
    ? {
        authentication: createAuthentication(
          pool,
          {
            baseUrl: config.PUBLIC_BASE_URL,
            secret: config.AUTH_SECRET,
          },
          resolveConnection,
        ),
        resolveConnection,
        database: {
          invalidate: resolveConnection.close,
          systemPool: pool,
          systemHost: new URL(config.DATABASE_URL).hostname,
          masterKey: config.SECRETS_MASTER_KEY,
          now: () => new Date(),
        },
        review: {
          now: () => new Date(),
          publishMatcher: queue ? publishMatching(queue) : undefined,
        },
        audit:
          config.PROCESS_ROLE === 'api'
            ? {
                model: createGeminiModel({
                  emit,
                  vertex: {
                    project: config.GOOGLE_CLOUD_PROJECT,
                    location: config.VERTEX_LOCATION,
                  },
                  models: {
                    triage: config.GEMINI_MODEL_TRIAGE,
                    standard: config.GEMINI_MODEL_STANDARD,
                    strong: config.GEMINI_MODEL_STRONG,
                  },
                }),
                publishMatcher: queue ? publishMatching(queue) : undefined,
              }
            : undefined,
        webhook: {
          resolveConnection,
          lookupConnection: createConnectionLookup(pool, resolveConnection),
          secretStore: createSecretStore(config.SECRETS_MASTER_KEY),
          providers,
          now: () => new Date(),
          publish: queue ? publishCoalesce(queue, config.INGEST_DEBOUNCE_SECONDS) : undefined,
          publishNotification: queue ? publishNotification(queue) : undefined,
          publishMedia: queue ? publishMedia(queue) : undefined,
          publishStart: queue ? publishStart(queue) : undefined,
          publishComprehend: queue ? publishComprehension(queue) : undefined,
        },
        mail: { masterKey: config.SECRETS_MASTER_KEY, now: () => new Date() },
        telegram: providers.adapterFor('telegram'),
        connectionSetup: {
          ...createAccountClaims(pool),
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
    const { createGeminiTranscriber } = await import('./platform/llm/transcription.js');
    const { createGeminiEmbedding } = await import('./platform/llm/gemini-embedding.js');
    const logger = createLogger(config.LOG_LEVEL);

    const pipelineServices = {
      resolveConnection,
      now: () => new Date(),
      debounceSeconds: config.INGEST_DEBOUNCE_SECONDS,
      providers,
      secretStore: createSecretStore(config.SECRETS_MASTER_KEY),
      publicBaseUrl: config.PUBLIC_BASE_URL,
      embedding: createGeminiEmbedding({
        vertex: {
          project: config.GOOGLE_CLOUD_PROJECT,
          location: config.VERTEX_EMBEDDING_LOCATION,
        },
        model: config.GEMINI_MODEL_EMBEDDING,
      }),
      embeddingModel: config.GEMINI_MODEL_EMBEDDING,
      model: createGeminiModel({
        emit,
        vertex: { project: config.GOOGLE_CLOUD_PROJECT, location: config.VERTEX_LOCATION },
        models: {
          triage: config.GEMINI_MODEL_TRIAGE,
          standard: config.GEMINI_MODEL_STANDARD,
          strong: config.GEMINI_MODEL_STRONG,
        },
      }),
      transcriber: createGeminiTranscriber({
        emit,
        vertex: { project: config.GOOGLE_CLOUD_PROJECT, location: config.VERTEX_LOCATION },
        model: config.GEMINI_MODEL_STANDARD,
      }),
      audit: (event: unknown) => logger.warn(event, 'Pipeline injection screen'),
      alert: (event: unknown) => logger.error(event, 'Pipeline operator alert'),
    };

    await registerPipelineJobs(queue, pipelineServices);
    const ownQueues = ownDatabaseQueues(pool, {
      ...tenantOptions,
      register: (tenantQueue) => registerPipelineJobs(tenantQueue, pipelineServices),
      alert: pipelineServices.alert,
    });

    await ownQueues.refresh();
    process.once('SIGTERM', () => {
      void ownQueues.stop();
    });
  }

  if (queue && config.PROCESS_ROLE === 'scheduler') {
    const { registerSchedulerJobs } = await import('./roles/scheduler.js');

    const database =
      config.SYSTEM_SMTP_URL && config.SYSTEM_MAIL_FROM
        ? {
            ...tenantOptions,
            systemPool: pool,
            now: () => new Date(),
            sendMail: createSystemMailer(config.SYSTEM_SMTP_URL, config.SYSTEM_MAIL_FROM),
            alert: (event: { workspaceId: string; code: string }) =>
              createLogger(config.LOG_LEVEL).error(event, 'Database probe unavailable'),
          }
        : undefined;

    await registerSchedulerJobs(queue, pool, database, { emit, now: () => new Date() });
    const ownQueues = ownDatabaseQueues(pool, {
      ...tenantOptions,
      scheduling: true,
      register: async (tenantQueue, tenantPool) => {
        const workspace = (
          await tenantPool.query<{ id: string }>('SELECT id FROM scheduled_workspaces()')
        ).rows[0];

        await registerSchedulerJobs(tenantQueue, tenantPool, undefined, {
          emit,
          now: () => new Date(),
          databaseId: workspace.id,
        });
      },
      alert: (event) =>
        createLogger(config.LOG_LEVEL).error(event, 'Database scheduler unavailable'),
    });

    await ownQueues.refresh();
    process.once('SIGTERM', () => {
      void ownQueues.stop();
    });
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

  app.listen(config.PORT);
}
