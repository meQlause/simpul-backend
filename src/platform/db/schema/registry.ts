import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, check, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { rowColumns, tenantColumns, reference, instant, bytes } from './identity.js';

export const workspaceKeys = pgTable('workspace_keys', {
  workspaceId: uuid('workspace_id').primaryKey(),
  createdAt: instant('created_at').defaultNow().notNull(),
  wrappedKey: bytes('wrapped_key').notNull(),
  masterKeyVersion: integer('master_key_version').default(1).notNull(),
});

export const secrets = pgTable(
  'secrets',
  {
    ...rowColumns(),
    workspaceId: reference('workspace_id', () => workspaceKeys.workspaceId).notNull(),
    purpose: text('purpose').notNull(),
    ciphertext: bytes('ciphertext').notNull(),
    nonce: bytes('nonce').notNull(),
  },
  (table) => [
    check(
      'secrets_purpose_valid',
      sql`${table.purpose} IN ('bot_token','webhook_secret','mail_password','database_url')`,
    ),
    check('secrets_nonce_length', sql`octet_length(${table.nonce}) = 12`),
  ],
);

export const mailConnections = pgTable(
  'mail_connections',
  {
    ...tenantColumns(),
    host: text('host').notNull(),
    port: integer('port').notNull(),
    username: text('username').notNull(),
    fromAddress: text('from_address').notNull(),
    passwordSecretRef: text('password_secret_ref').notNull(),
    verifiedAt: instant('verified_at'),
  },
  (table) => [
    check('mail_port_valid', sql`${table.port} BETWEEN 1 AND 65535`),
    uniqueIndex('mail_ws_uq').on(table.workspaceId),
  ],
);

export const workspaceDatabases = pgTable(
  'workspace_databases',
  {
    workspaceId: uuid('workspace_id').primaryKey(),
    createdAt: instant('created_at').defaultNow().notNull(),
    workspaceName: text('workspace_name').notNull(),
    timezone: text('timezone').notNull(),
    adminAuthUserId: text('admin_auth_user_id').notNull(),
    status: text('status').default('pending').notNull(),
    urlSecretRef: reference('url_secret_ref', () => secrets.id),
    host: text('host'),
    port: integer('port'),
    databaseName: text('database_name'),
    schemaVersion: text('schema_version'),
    availabilityAckAt: instant('availability_ack_at'),
    availabilityAckBy: text('availability_ack_by'),
    connectedAt: instant('connected_at'),
    unreachableSince: instant('unreachable_since'),
    probeStreak: integer('probe_streak').default(0).notNull(),
    updatedAt: instant('updated_at').defaultNow().notNull(),
  },
  (table) => [
    check('wsdb_name_length', sql`char_length(${table.workspaceName}) BETWEEN 1 AND 80`),
    check('wsdb_port_valid', sql`${table.port} BETWEEN 1 AND 65535`),
    check(
      'wsdb_ack_before_connection',
      sql`${table.urlSecretRef} IS NULL OR ${table.availabilityAckAt} IS NOT NULL`,
    ),
    check(
      'wsdb_status_valid',
      sql`${table.status} IN ('pending','connected','unreachable','migration_failed')`,
    ),
    check(
      'wsdb_status_matches_state',
      sql`(${table.status} = 'pending') = (${table.urlSecretRef} IS NULL) AND (${table.status} = 'unreachable') = (${table.unreachableSince} IS NOT NULL)`,
    ),
    uniqueIndex('wsdb_admin_uq').on(table.adminAuthUserId),
    index('wsdb_status_idx').on(table.status),
  ],
);

export const connectionRoutes = pgTable(
  'connection_routes',
  {
    botConnectionId: uuid('bot_connection_id').primaryKey(),
    createdAt: instant('created_at').defaultNow().notNull(),
    workspaceId: reference(
      'workspace_id',
      () => workspaceDatabases.workspaceId,
      'cascade',
    ).notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
  },
  (table) => [
    check('route_provider_valid', sql`${table.provider} IN ('telegram', 'fake')`),
    uniqueIndex('route_account_uq').on(table.provider, table.providerAccountId),
  ],
);
