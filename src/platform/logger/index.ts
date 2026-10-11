import pino, { type LevelWithSilent, type DestinationStream } from 'pino';

export function createLogger(level: LevelWithSilent, destination?: DestinationStream) {
  return pino(
    {
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
    },
    destination,
  );
}
