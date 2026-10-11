import express from 'express';
import pino from 'pino';
import request from 'supertest';
import { expect, test } from 'vitest';
import { errorHandler } from '../../../../src/platform/http/error-handler.js';
import { requestId } from '../../../../src/platform/http/request-id.js';
import { requestLogger } from '../../../../src/platform/http/request-logger.js';

test('A thrown non-domain error returns 500 E-INTERNAL with no stack trace, SQL or driver text in the body', async () => {
  const lines: string[] = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(line) });
  const app = express();

  app.disable('x-powered-by');
  app.use(requestId, requestLogger(logger));
  app.get('/failure', () =>
    Promise.reject(new TypeError('SQL SELECT password FROM secrets: driver-private-text')),
  );
  app.use(errorHandler);

  const response = await request(app).get('/failure');

  expect(response.status).toBe(500);
  expect(response.body).toEqual({
    error: {
      code: 'E-INTERNAL',
      message:
        'Workspace could not be loaded. Your settings were not changed. Retry when the service is available.',
      requestId: response.headers['x-request-id'],
    },
  });
  expect(response.text).not.toMatch(
    /SQL|SELECT|password|secrets|driver-private-text|TypeError|stack/u,
  );
  expect(lines.some((line) => JSON.parse(line).level === 50)).toBe(true);
  expect(lines.join('')).not.toContain('driver-private-text');
});
