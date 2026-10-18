import { z as zod } from 'zod';

const databaseUrl = zod
  .string()
  .url()
  .regex(/^postgres(?:ql)?:\/\//u);
const secret = zod.string().min(32);
const modelId = zod.string().min(1);

export const configSchema = zod.object({
  PROCESS_ROLE: zod.enum(['api', 'webhook', 'worker', 'scheduler']),
  // One port per role lets every role run on one machine; a deployment keeps the default.
  PORT: zod.coerce.number().int().positive().max(65535).default(3000),
  DATABASE_URL: databaseUrl,
  DATABASE_MIGRATION_URL: databaseUrl,
  DATABASE_QUEUE_URL: databaseUrl,
  PUBLIC_BASE_URL: zod.string().url().startsWith('https://'),
  TELEGRAM_API_BASE: zod.string().url().startsWith('https://'),
  TELEGRAM_CALL_TIMEOUT_MS: zod.coerce.number().int().positive().max(10000).default(10000),
  TELEGRAM_SEND_PER_SECOND: zod.coerce.number().int().positive().max(30).default(30),
  TELEGRAM_SEND_PER_CHAT_PER_MINUTE: zod.coerce.number().int().positive().max(20).default(20),
  INGEST_DEBOUNCE_SECONDS: zod.coerce.number().int().positive().default(12),
  AUTH_SECRET: secret,
  // B-9: models run on Vertex AI in this project, as the process's Google identity.
  GOOGLE_CLOUD_PROJECT: zod.string().min(1),
  VERTEX_LOCATION: zod.string().min(1).default('global'),
  VERTEX_EMBEDDING_LOCATION: zod.string().min(1).default('asia-southeast1'),
  GEMINI_MODEL_TRIAGE: modelId.default('gemini-3.1-flash-lite'),
  GEMINI_MODEL_STANDARD: modelId.default('gemini-3.8-flash'),
  GEMINI_MODEL_STRONG: modelId.default('gemini-3.1-pro-preview'),
  GEMINI_MODEL_EMBEDDING: modelId.default('gemini-embedding-001'),
  SECRETS_MASTER_KEY: zod
    .string()
    .base64()
    .refine((value) => Buffer.byteLength(value, 'base64') === 32),
  SYSTEM_SMTP_URL: zod
    .string()
    .url()
    .regex(/^smtps?:\/\//u)
    .optional(),
  SYSTEM_MAIL_FROM: zod.email().optional(),
  LOG_LEVEL: zod
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});
