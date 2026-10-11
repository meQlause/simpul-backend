import { execFileSync } from 'node:child_process';
import postgres from 'pg';
import { afterAll, beforeAll, expect, vi } from 'vitest';

const dockerExecutable =
  process.platform === 'win32'
    ? 'C:/Program Files/Docker/Docker/resources/bin/docker.exe'
    : '/usr/bin/docker';

export function databaseFixture(
  maxConnections = 1,
  options: { image?: string; tls?: boolean; passwordAuth?: boolean; restartable?: boolean } = {},
) {
  let containerId = '';
  let certificate = '';
  const pool = new postgres.Pool({ max: maxConnections });

  beforeAll(async () => {
    containerId = execFileSync(
      dockerExecutable,
      [
        'run',
        '-d',
        '--rm',
        '--label',
        'pspt.test.project=simpul',
        '--label',
        'pspt.test.disposable=true',
        '--tmpfs',
        '/var/lib/postgresql/data:rw,size=256m',
        '-e',
        options.passwordAuth
          ? 'POSTGRES_HOST_AUTH_METHOD=scram-sha-256'
          : 'POSTGRES_HOST_AUTH_METHOD=trust',
        '-e',
        'POSTGRES_PASSWORD=test-only-db-password',
        '-p',
        '127.0.0.1::5432',
        options.image ?? 'pgvector/pgvector:0.8.7-pg15-trixie',
        ...(options.restartable
          ? ['sh', '-c', 'docker-entrypoint.sh postgres & wait; exec sleep infinity']
          : []),
      ],
      { encoding: 'utf8' },
    ).trim();
    const address = execFileSync(dockerExecutable, ['port', containerId, '5432/tcp'], {
      encoding: 'utf8',
    }).trim();

    const credentials = options.passwordAuth ? 'postgres:test-only-db-password' : 'postgres';

    pool.options.connectionString = `postgresql://${credentials}@${address}/postgres`;
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

    if (options.tls) {
      certificate = await enableTestTls(containerId, pool);
    }
  }, 30000);
  afterAll(async () => {
    try {
      await pool.end();
    } finally {
      if (containerId) {
        execFileSync(dockerExecutable, ['rm', '-f', '-v', containerId]);
      }
    }
  });

  return Object.assign(pool, {
    certificate: () => certificate,
    ...databaseControl(() => containerId),
    ...databaseCopy(() => containerId),
  });
}

function databaseCopy(containerId: () => string) {
  return {
    dump: () =>
      execFileSync(
        dockerExecutable,
        ['exec', containerId(), 'pg_dump', '-U', 'postgres', '--no-owner', '--no-acl', 'postgres'],
        { encoding: 'utf8' },
      ),
    restore: (sql: string) =>
      execFileSync(
        dockerExecutable,
        [
          'exec',
          '-i',
          containerId(),
          'psql',
          '-U',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
          'postgres',
        ],
        { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      ),
  };
}

function databaseControl(containerId: () => string) {
  return {
    stopDatabase: () =>
      execFileSync(dockerExecutable, [
        'exec',
        '-u',
        'postgres',
        containerId(),
        'pg_ctl',
        '-D',
        '/var/lib/postgresql/data',
        'stop',
        '-m',
        'fast',
      ]),
    startDatabase: () =>
      execFileSync(dockerExecutable, [
        'exec',
        '-u',
        'postgres',
        containerId(),
        'pg_ctl',
        '-D',
        '/var/lib/postgresql/data',
        '-l',
        '/var/lib/postgresql/data/simpul-postgres.log',
        'start',
      ]),
  };
}

async function enableTestTls(containerId: string, pool: postgres.Pool) {
  const command = (args: string[]) =>
    execFileSync(dockerExecutable, ['exec', containerId, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

  command([
    'openssl',
    'req',
    '-new',
    '-x509',
    '-nodes',
    '-newkey',
    'rsa:2048',
    '-keyout',
    '/var/lib/postgresql/data/simpul-test.key',
    '-out',
    '/var/lib/postgresql/data/simpul-test.crt',
    '-days',
    '1',
    '-subj',
    '/CN=customer.example',
    '-addext',
    'subjectAltName=DNS:customer.example',
  ]);
  command(['chmod', '600', '/var/lib/postgresql/data/simpul-test.key']);
  command(['chown', 'postgres:postgres', '/var/lib/postgresql/data/simpul-test.key']);
  await pool.query("ALTER SYSTEM SET ssl_cert_file = '/var/lib/postgresql/data/simpul-test.crt'");
  await pool.query("ALTER SYSTEM SET ssl_key_file = '/var/lib/postgresql/data/simpul-test.key'");
  await pool.query("ALTER SYSTEM SET ssl = 'on'");
  await pool.query('SELECT pg_reload_conf()');

  return command(['cat', '/var/lib/postgresql/data/simpul-test.crt']);
}
