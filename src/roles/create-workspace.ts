import type { readConfig } from '../platform/config/index.js';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createSystemPool } from '../platform/db/index.js';
import { createConnectionResolver } from '../platform/db/connection-resolver.js';
import { createWorkspace, createWorkspaceSchema } from '../features/workspace/index.js';

const tokenLifetimeMs = 3600000;

export async function runCreateWorkspace(
  config: ReturnType<typeof readConfig>,
  arguments_: string[],
) {
  const { values } = parseArgs({
    args: arguments_,
    options: {
      name: { type: 'string' },
      'admin-name': { type: 'string' },
      'admin-email': { type: 'string' },
      timezone: { type: 'string' },
      database: { type: 'string' },
    },
  });
  const input = createWorkspaceSchema.parse(values);

  if (input.database === 'own' && (!config.SYSTEM_SMTP_URL || !config.SYSTEM_MAIL_FROM)) {
    throw new Error('SYSTEM_SMTP_URL and SYSTEM_MAIL_FROM are required for --database own');
  }

  const pool = createSystemPool(config.DATABASE_URL);
  const now = new Date();
  const token = randomUUID();

  try {
    await createWorkspace(createConnectionResolver(pool), {
      input,
      workspaceId: randomUUID(),
      adminId: randomUUID(),
      authUserId: randomUUID(),
      token,
      now,
      expiresAt: new Date(now.getTime() + tokenLifetimeMs),
    });
    const link = new URL('/set-password', config.PUBLIC_BASE_URL);

    link.searchParams.set('token', token);
    process.stdout.write(`${link.href}\n`);
  } finally {
    await pool.end();
  }
}
