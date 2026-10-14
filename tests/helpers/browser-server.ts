import { createServer } from 'node:http';
import { browserChannels } from './browser-channels.js';
import { Pool } from 'pg';
import { createApp } from '../../src/app.js';
import { createAuthentication, provisionAdmin } from '../../src/features/auth/index.js';
import { createConnectionResolver } from '../../src/platform/db/connection-resolver.js';
import { applyMigrations } from './migrations.js';
import { loadPointStarSeed, pointStarSeed } from '../fixtures/point-star.js';

async function waitForDatabase(pool: Pool) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await pool.query('SELECT 1');

      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error('Browser fixture database did not start');
}

const PASSWORD = 'test-password-123';
const browserUsers = [
  { id: 'browser-admin', name: 'Siti Aminah', email: 'admin@pointstar.example' },
  // Not the workspace admin: signs in, then every admin endpoint answers 403.
  { id: 'browser-staff', name: 'Budi Santoso', email: 'budi@pointstar.example' },
];

async function browserAuthentication(pool: Pool) {
  const client = await pool.connect();

  try {
    for (const user of browserUsers) {
      await provisionAdmin(client, {
        ...user,
        token: `${user.id}-password-token`,
        now: new Date(),
        expiresAt: new Date('2099-01-01T00:00:00Z'),
      });
      await client.query('UPDATE people SET auth_user_id = $1 WHERE name = $2', [
        user.id,
        user.name,
      ]);
    }
  } finally {
    client.release();
  }

  const authentication = createAuthentication(pool, {
    baseUrl: process.env.SIMPUL_BROWSER_BASE_URL ?? 'http://127.0.0.1:4173',
    secret: 'browser-test-only-secret-with-more-than-32-characters',
  });

  for (const user of browserUsers) {
    await authentication.api.resetPassword({
      body: { token: `${user.id}-password-token`, newPassword: PASSWORD },
    });
  }

  return authentication;
}

export async function startBrowserServer(pool: Pool, port: number) {
  await waitForDatabase(pool);
  await applyMigrations(pool);
  await loadPointStarSeed(pool, pointStarSeed({ now: () => new Date('2026-10-10T04:01:00Z') }));
  const authentication = await browserAuthentication(pool);
  const services = {
    authentication,
    resolveConnection: createConnectionResolver(pool),
    work: { now: () => new Date('2026-10-10T04:01:00Z') },
    mail: {
      masterKey: Buffer.alloc(32, 7).toString('base64'),
      // Only the Point Star relay accepts a login; any other host is refused.
      verifyMail: async (server: { host: string }) => {
        if (server.host !== 'smtp.pointstar.example') {
          throw new Error('refused');
        }
      },
      now: () => new Date('2026-10-10T04:01:00Z'),
    },
    overview: { now: () => new Date('2026-10-10T04:01:00Z') },
    audit: { model: { generate: async () => '{"operations":[]}' } },
    ...(await browserChannels(pool)),
  };
  const app = createApp('api', undefined, undefined, services);
  const webhook = createApp('webhook', undefined, undefined, services);
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/api/v1/webhooks/')) {
      webhook(request, response);
    } else {
      app(request, response);
    }
  }).listen(port, '127.0.0.1');

  await new Promise<void>((accept, reject) => {
    server.once('listening', accept);
    server.once('error', reject);
  });

  return server;
}

if (process.env.SIMPUL_BROWSER_FIXTURE === '1') {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const server = await startBrowserServer(pool, 0);
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Browser fixture has no TCP address');
  }

  process.stdout.write(`BROWSER_FIXTURE_READY http://127.0.0.1:${address.port}\n`);
  process.once('SIGTERM', () => {
    server.close(() => {
      void pool.end();
    });
  });
}
