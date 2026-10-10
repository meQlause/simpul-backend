import { betterAuth } from 'better-auth';
import type { Pool } from 'pg';
export { provisionAdmin } from './auth.service.js';

export function createAuthentication(database: Pool, config: { baseUrl: string; secret: string }) {
  return betterAuth({
    database,
    baseURL: config.baseUrl,
    secret: config.secret,
    emailAndPassword: { enabled: true, disableSignUp: true },
  });
}
