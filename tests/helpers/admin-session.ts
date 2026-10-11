import type { Pool } from 'pg';
import { createAuthentication, provisionAdmin } from '../../src/features/auth/index.js';
import { systemDatabase, prepareDatabase, createConnectionResolver } from './database-mode.js';

export async function signInSeedAdmin(pool: Pool, input: { id: string; email: string }) {
  const system = systemDatabase(pool);
  const client = await system.connect();

  try {
    await provisionAdmin(client, {
      ...input,
      name: 'Siti Aminah',
      token: `${input.id}-password-token`,
      now: new Date(),
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
  } finally {
    client.release();
  }

  await pool.query(
    "UPDATE people SET auth_user_id = $1 WHERE id = md5('point-star-person-1')::uuid",
    [input.id],
  );
  const workspace = (
    await pool.query('SELECT workspace_id FROM people WHERE auth_user_id = $1', [input.id])
  ).rows[0];

  await prepareDatabase(pool, workspace.workspace_id);

  const authentication = createAuthentication(
    system,
    {
      baseUrl: 'https://simpul.example',
      secret: 'test-only-auth-secret-with-more-than-32-characters',
    },
    createConnectionResolver(pool),
  );

  await authentication.api.resetPassword({
    body: { token: `${input.id}-password-token`, newPassword: 'test-password-123' },
  });
  const login = await authentication.api.signInEmail({
    body: { email: input.email, password: 'test-password-123' },
    asResponse: true,
  });

  return { authentication, cookie: login.headers.get('set-cookie') ?? '' };
}
