import { execFileSync } from 'node:child_process';
import postgres from 'pg';
import { afterAll, beforeAll, expect, vi } from 'vitest';

const dockerExecutable =
  process.platform === 'win32'
    ? 'C:/Program Files/Docker/Docker/resources/bin/docker.exe'
    : '/usr/bin/docker';

export function databaseFixture() {
  let containerId = '';
  const pool = new postgres.Pool({ max: 1 });
  beforeAll(async () => {
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
    pool.options.connectionString = `postgresql://postgres@${address}/postgres`;
    await vi.waitFor(
      () =>
        expect(
          execFileSync(
            dockerExecutable,
            ['exec', containerId, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
            { encoding: 'utf8' },
          ),
        ).toContain('accepting connections'),
      { timeout: 15000 },
    );
  }, 30000);
  afterAll(async () => {
    await pool.end();
    if (containerId) {
      execFileSync(dockerExecutable, ['rm', '-f', containerId]);
    }
  });
  return pool;
}
