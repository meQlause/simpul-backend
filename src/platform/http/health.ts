import type { RequestHandler } from 'express';

const status = { healthy: 200, unavailable: 503 } as const;

export function health(checkDatabase: () => Promise<unknown>): RequestHandler {
  return async (_request, response) => {
    try {
      await checkDatabase();
      response.status(status.healthy).json({ data: { status: 'healthy' } });
    } catch {
      response.status(status.unavailable).json({ data: { status: 'unavailable' } });
    }
  };
}
