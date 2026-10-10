import pino from 'pino';
import request from 'supertest';
import { expect, test } from 'vitest';
import { createApp } from '../../../../src/app.js';

test('An unknown path returns the envelope with E-NOT-FOUND and a requestId that also appears in the log line', async () => {
  const lines: string[] = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(line) });
  const response = await request(createApp('api', undefined, logger)).get(
    '/missing?token=private-value',
  );

  expect(response.status).toBe(404);
  expect(response.body.error).toMatchObject({
    code: 'E-NOT-FOUND',
    requestId: response.headers['x-request-id'],
  });
  expect(response.body.error.requestId).toEqual(expect.any(String));
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
    requestId: response.body.error.requestId,
    method: 'GET',
    path: '/missing',
    status: 404,
  });
  expect(lines.join('')).not.toContain('private-value');
});
