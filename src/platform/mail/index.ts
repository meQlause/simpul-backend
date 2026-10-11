import nodemailer from 'nodemailer';

const TLS_PORT = 465;
const TIMEOUT_MS = 10000;

export async function verifyMail(credentials: {
  host: string;
  port: number;
  username: string;
  password: string;
}) {
  const transport = nodemailer.createTransport({
    host: credentials.host,
    port: credentials.port,
    secure: credentials.port === TLS_PORT,
    requireTLS: true,
    auth: { user: credentials.username, pass: credentials.password },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
    logger: false,
    debug: false,
    transactionLog: false,
  });

  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}
