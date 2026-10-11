import { betterAuth } from 'better-auth';
import type { Pool } from 'pg';
import { createAdminResolver } from './auth.service.js';
import { createConnectionResolver } from '../../platform/db/connection-resolver.js';
import type { ConnectionResolver } from '../../platform/db/connection-resolver.js';

export { provisionAdmin } from './auth.service.js';

export function createAuthentication(
  database: Pool,
  config: { baseUrl: string; secret: string },
  resolveConnection: ConnectionResolver = createConnectionResolver(database),
) {
  const auth = betterAuth({
    database,
    baseURL: config.baseUrl,
    secret: config.secret,
    emailAndPassword: { enabled: true, disableSignUp: true },
  });

  return Object.assign(auth, {
    resolveAdmin: createAdminResolver(
      (headers) => auth.api.getSession({ headers }),
      database,
      resolveConnection,
    ),
  });
}
