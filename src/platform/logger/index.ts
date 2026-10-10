import pino, { type LevelWithSilent } from 'pino';

export function createLogger(level: LevelWithSilent) {
  return pino({
    level,
    redact: [
      '*.token',
      '*.bot_token',
      '*.secret',
      '*.password',
      '*.connectionString',
      '*.databaseUrl',
      'headers.authorization',
      'headers["x-telegram-bot-api-secret-token"]',
    ],
  });
}
