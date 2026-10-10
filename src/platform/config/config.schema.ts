import { z as zod } from 'zod';

const databaseUrl = zod
  .string()
  .url()
  .regex(/^postgres(?:ql)?:\/\//u);
const secret = zod.string().min(32);
const modelId = zod.string().min(1);

export const configSchema = zod.object({
  PROCESS_ROLE: zod.enum(['api', 'webhook', 'worker', 'scheduler']),
  DATABASE_URL: databaseUrl,
  DATABASE_MIGRATION_URL: databaseUrl,
  DATABASE_QUEUE_URL: databaseUrl,
  PUBLIC_BASE_URL: zod.string().url().startsWith('https://'),
  TELEGRAM_API_BASE: zod.string().url().startsWith('https://'),
  AUTH_SECRET: secret,
  GEMINI_API_KEY: zod.string().min(1),
  GEMINI_MODEL_TRIAGE: modelId,
  GEMINI_MODEL_STANDARD: modelId,
  GEMINI_MODEL_STRONG: modelId,
  GEMINI_MODEL_EMBEDDING: modelId,
  SECRETS_MASTER_KEY: zod
    .string()
    .base64()
    .refine((value) => Buffer.byteLength(value, 'base64') === 32),
  SYSTEM_SMTP_URL: zod.string().url().optional(),
  SYSTEM_MAIL_FROM: zod.email().optional(),
  LOG_LEVEL: zod
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});
