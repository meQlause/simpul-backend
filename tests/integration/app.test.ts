import request from 'supertest';
import { expect, test } from 'vitest';
import { createApp } from '../../src/app.js';

test('PROCESS_ROLE=webhook mounts no /api/v1 admin route: GET /api/v1/me returns 404 E-NOT-FOUND', async () => {
  const response = await request(createApp('webhook')).get('/api/v1/me');

  expect(response.status).toBe(404);
  expect(response.body.error.code).toBe('E-NOT-FOUND');
});
