import { Client } from 'pg';

const timeoutMilliseconds = 2000;

export async function checkDatabase(connectionString: string) {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: timeoutMilliseconds,
    query_timeout: timeoutMilliseconds,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    await client.end();
  }
}
