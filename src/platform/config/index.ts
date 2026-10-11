import { configSchema } from './config.schema.js';

export function readConfig(environment: NodeJS.ProcessEnv) {
  const parsed = configSchema.safeParse(environment);

  if (parsed.success) {
    return parsed.data;
  }

  const fields = parsed.error.issues.map((issue) => issue.path.join('.'));
  const error = new Error(`Invalid configuration: ${fields.join(', ')}`);

  error.name = 'ConfigurationError';
  throw error;
}
