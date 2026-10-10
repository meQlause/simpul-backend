import { test, expect } from 'vitest';
import { databaseFixture } from '../helpers/database.js';
import { startBrowserServer } from '../helpers/browser-server.js';

const pool = databaseFixture();

test('The browser fixture signs in over HTTP and serves the Point Star roster', async () => {
  const server = await startBrowserServer(pool, 0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Missing browser fixture port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${baseUrl}/api/v1/people`)).status).toBe(401);
    const login = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@pointstar.example', password: 'test-password-123' }),
    });
    expect(login.status).toBe(200);
    const roster = await fetch(`${baseUrl}/api/v1/people`, {
      headers: { Cookie: login.headers.get('set-cookie') ?? '' },
    });
    expect(roster.status).toBe(200);
    const response = (await roster.json()) as { data: { name: string }[] };
    expect(response.data).toHaveLength(5);
    expect(response.data).toContainEqual(expect.objectContaining({ name: 'Budi Santoso' }));
  } finally {
    await new Promise<void>((accept, reject) =>
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          accept();
        }
      }),
    );
  }
});
