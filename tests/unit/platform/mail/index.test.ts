import { createServer } from 'node:net';
import { once } from 'node:events';
import { expect, test } from 'vitest';
import { verifyMail } from '../../../../src/platform/mail/index.js';

test('SMTP verification refuses a server without TLS before attempting authentication', async () => {
  const commands: string[] = [];
  const server = createServer((socket) => {
    socket.write('220 test SMTP\r\n');
    socket.on('data', (data) => {
      commands.push(data.toString());
      if (data.toString().startsWith('EHLO')) {
        socket.write('250-test SMTP\r\n250 AUTH PLAIN LOGIN\r\n');
      } else {
        socket.write('454 TLS unavailable\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Missing SMTP test port');
    }
    await expect(
      verifyMail({
        host: '127.0.0.1',
        port: address.port,
        username: 'test-user',
        password: 'test-password',
      }),
    ).rejects.toThrow();
    expect(commands.join('')).not.toContain('AUTH ');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
