import nodemailer from 'nodemailer';

const TLS_PORT = 465;
const TIMEOUT_MS = 10000;

type Credentials = {
  host: string;
  port: number;
  username: string;
  password: string;
};

function mailTransport(credentials: Credentials) {
  return nodemailer.createTransport({
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
}

export async function verifyMail(credentials: Credentials) {
  const transport = mailTransport(credentials);

  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

export async function sendMail(
  credentials: Credentials,
  message: { from: string; to: string; subject: string; text: string; messageId: string },
) {
  const transport = mailTransport(credentials);

  try {
    await transport.sendMail(message);
  } finally {
    transport.close();
  }
}
