import { sendMail } from './index.js';

const IMPLICIT_TLS_PORT = 465;
const STARTTLS_PORT = 587;

export function createSystemMailer(connection: string, from: string) {
  const url = new URL(connection);

  if (!['smtp:', 'smtps:'].includes(url.protocol)) {
    throw new Error('SYSTEM_SMTP_URL must use smtp or smtps');
  }

  const secure = url.protocol === 'smtps:';
  const credentials = {
    host: url.hostname.replace(/^\[|\]$/gu, ''),
    port: Number(url.port || (secure ? IMPLICIT_TLS_PORT : STARTTLS_PORT)),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    secure,
  };

  return async (message: Omit<Parameters<typeof sendMail>[1], 'from'>) => {
    await sendMail(credentials, { ...message, from });
  };
}
