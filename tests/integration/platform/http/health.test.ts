import { execFileSync } from 'node:child_process';
import request from 'supertest';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createApp } from '../../../../src/app.js';
import { checkDatabase } from '../../../../src/platform/db/health.js';

const dockerExecutable =
  process.platform === 'win32'
    ? 'C:/Program Files/Docker/Docker/resources/bin/docker.exe'
    : '/usr/bin/docker';

let containerId = '';
let connectionString = '';

beforeAll(() => {
  containerId = execFileSync(
    dockerExecutable,
    [
      'run',
      '-d',
      '--rm',
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-p',
      '127.0.0.1::5432',
      'pgvector/pgvector:0.8.7-pg15-trixie',
    ],
    { encoding: 'utf8' },
  ).trim();
  const address = execFileSync(dockerExecutable, ['port', containerId, '5432/tcp'], {
    encoding: 'utf8',
  }).trim();
  connectionString = `postgresql://postgres@${address}/postgres`;
}, 30000);

afterAll(() => {
  if (containerId) {
    execFileSync(dockerExecutable, ['rm', '-f', containerId]);
  }
});

test('GET /health returns 200 with the database up and 503 with it down', async () => {
  await expect
    .poll(
      () =>
        execFileSync(
          dockerExecutable,
          ['exec', containerId, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
          {
            encoding: 'utf8',
          },
        ),
      { timeout: 15000 },
    )
    .toContain('accepting connections');
  const app = createApp('api', () => checkDatabase(connectionString));
  const healthy = await request(app).get('/health');
  expect(healthy.status).toBe(200);

  execFileSync(dockerExecutable, ['stop', containerId]);
  containerId = '';
  const unavailable = await request(app).get('/health');
  expect(unavailable.status).toBe(503);
}, 30000);
