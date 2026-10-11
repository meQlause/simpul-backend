import type { Pool } from 'pg';
import { createAuthentication, provisionAdmin } from '../../src/features/auth/index.js';

export async function signInSeedAdmin(pool: Pool, input: { id: string; email: string }) {
  const client = await pool.connect();

  try {
    await provisionAdmin(client, {
      ...input,
      name: 'Siti Aminah',
      token: `${input.id}-password-token`,
      now: new Date(),
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
    await client.query(
      "UPDATE people SET auth_user_id = $1 WHERE id = md5('point-star-person-1')::uuid",
      [input.id],
    );
  } finally {
    client.release();
  }

  const authentication = createAuthentication(pool, {
    baseUrl: 'https://simpul.example',
    secret: 'test-only-auth-secret-with-more-than-32-characters',
  });

  await authentication.api.resetPassword({
    body: { token: `${input.id}-password-token`, newPassword: 'test-password-123' },
  });
  const login = await authentication.api.signInEmail({
    body: { email: input.email, password: 'test-password-123' },
    asResponse: true,
  });

  return { authentication, cookie: login.headers.get('set-cookie') ?? '' };
}
