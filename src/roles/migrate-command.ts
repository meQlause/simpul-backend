import type { readConfig } from '../platform/config/index.js';
import { createSystemPool } from '../platform/db/index.js';
import { createSecretStore } from '../platform/secrets/index.js';
import { createSystemMailer } from '../platform/mail/system.js';
import { createLogger } from '../platform/logger/index.js';
import { migrateDatabases } from './migrate-databases.js';

export async function runMigrations(config: ReturnType<typeof readConfig>) {
  const pool = createSystemPool(config.DATABASE_MIGRATION_URL);
  const logger = createLogger(config.LOG_LEVEL);
  const sendMail =
    config.SYSTEM_SMTP_URL && config.SYSTEM_MAIL_FROM
      ? createSystemMailer(config.SYSTEM_SMTP_URL, config.SYSTEM_MAIL_FROM)
      : async () => {
          throw new Error('System SMTP sender is required for own database notices');
        };

  try {
    const failures = await migrateDatabases({
      systemPool: pool,
      systemHost: new URL(config.DATABASE_URL).hostname,
      secretStore: createSecretStore(config.SECRETS_MASTER_KEY),
      now: () => new Date(),
      sendMail,
      alert: (event) => logger.error(event, 'Own database migration failed'),
    });

    if (failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}
