import { expect, test, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { sendMail } from '../../../../src/platform/mail/index.js';

vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));

test('Workspace mail uses required TLS and closes its transport even when sending fails', async () => {
  const transport = {
    sendMail: vi.fn().mockRejectedValue(new Error('SMTP unavailable')),
    close: vi.fn(),
  };

  vi.mocked(nodemailer.createTransport).mockReturnValue(
    transport as unknown as ReturnType<typeof nodemailer.createTransport>,
  );
  await expect(
    sendMail(
      { host: 'smtp.example.test', port: 587, username: 'simpul', password: 'test-password' },
      {
        from: 'simpul@example.test',
        to: 'owner@example.test',
        subject: 'Simpul digest',
        text: 'Safe summaries',
        messageId: '<test@simpul>',
      },
    ),
  ).rejects.toThrow('SMTP unavailable');
  expect(nodemailer.createTransport).toHaveBeenCalledWith(
    expect.objectContaining({
      requireTLS: true,
      secure: false,
      logger: false,
      debug: false,
      transactionLog: false,
    }),
  );
  expect(transport.close).toHaveBeenCalledTimes(1);
});
