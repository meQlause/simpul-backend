import { expect, test, vi } from 'vitest';
import { sendMail } from '../../../../src/platform/mail/index.js';
import { createSystemMailer } from '../../../../src/platform/mail/system.js';

vi.mock('../../../../src/platform/mail/index.js', () => ({ sendMail: vi.fn() }));

test('system database notices use the configured sender and SMTP credentials without logging them', async () => {
  const message = {
    to: 'admin@example.test',
    subject: 'Database notice',
    text: 'Safe notice',
    messageId: '<probe@simpul.local>',
  };

  await createSystemMailer(
    'smtps://notice%40example.test:test%3Asecret@mail.example:2465',
    'simpul@example.test',
  )(message);
  expect(sendMail).toHaveBeenCalledWith(
    {
      host: 'mail.example',
      port: 2465,
      username: 'notice@example.test',
      password: 'test:secret',
      secure: true,
    },
    { ...message, from: 'simpul@example.test' },
  );
});

test('system SMTP configuration refuses non-mail URL schemes without revealing credentials', () => {
  expect(() =>
    createSystemMailer('https://user:private@mail.example', 'simpul@example.test'),
  ).toThrow('SYSTEM_SMTP_URL must use smtp or smtps');
});
