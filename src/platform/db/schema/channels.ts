import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  boolean,
  uuid,
  jsonb,
  primaryKey,
  foreignKey,
  check,
  index,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { tenantColumns, joinColumns, reference, instant, bytes, people } from './identity.js';

export const botConnections = pgTable(
  'bot_connections',
  {
    ...tenantColumns(),
    provider: text('provider').notNull(),
    connectionName: text('connection_name').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    botUsername: text('bot_username').notNull(),
    botName: text('bot_name').notNull(),
    tokenSecretRef: text('token_secret_ref').notNull(),
    webhookSecretRef: text('webhook_secret_ref').notNull(),
    status: text('status').default('pending').notNull(),
    verifiedAt: instant('verified_at'),
    webhookCheckedAt: instant('webhook_checked_at'),
    credentialVersion: integer('credential_version').default(1).notNull(),
    createdBy: reference('created_by', () => people.id).notNull(),
    updatedAt: instant('updated_at').defaultNow().notNull(),
  },
  (table) => [
    check('bot_provider_valid', sql`${table.provider} IN ('telegram', 'fake')`),
    check('bot_name_length', sql`char_length(${table.connectionName}) BETWEEN 1 AND 80`),
    check(
      'bot_status_valid',
      sql`${table.status} IN ('pending','ready','needs_action','degraded')`,
    ),
    uniqueIndex('bot_account_uq').on(table.provider, table.providerAccountId),
    uniqueIndex('bot_ws_provider_uq').on(table.workspaceId, table.provider),
    unique('bot_ws_id_uq').on(table.workspaceId, table.id),
  ],
);

export const channels = pgTable(
  'channels',
  {
    ...tenantColumns(),
    provider: text('provider').notNull(),
    botConnectionId: uuid('bot_connection_id').notNull(),
    providerChatId: text('provider_chat_id').notNull(),
    providerChatType: text('provider_chat_type'),
    providerChatTitle: text('provider_chat_title'),
    memberCount: integer('member_count'),
    displayName: text('display_name').notNull(),
    class: text('class').default('external').notNull(),
    primaryLanguage: text('primary_language').default('auto').notNull(),
    connectionStatus: text('connection_status').default('draft').notNull(),
    monitored: boolean('monitored').default(false).notNull(),
    privacyModeOk: boolean('privacy_mode_ok').default(false).notNull(),
    visibleIndicatorMessageId: text('visible_indicator_message_id'),
    verifiedAt: instant('verified_at'),
    monitoringStartedAt: instant('monitoring_started_at'),
    lastInboundAt: instant('last_inbound_at'),
    configVersion: integer('config_version').default(1).notNull(),
    verifiedConfigVersion: integer('verified_config_version'),
    authorizationAckAt: instant('authorization_ack_at'),
    authorizationAckBy: reference('authorization_ack_by', () => people.id),
    lastErrorCode: text('last_error_code'),
    likelyDomains: uuid('likely_domains')
      .array()
      .default(sql`'{}'`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'channels_bot_same_ws',
      columns: [table.workspaceId, table.botConnectionId],
      foreignColumns: [botConnections.workspaceId, botConnections.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('channels_provider_valid', sql`${table.provider} IN ('telegram', 'fake')`),
    check('channels_chat_type_valid', sql`${table.providerChatType} IN ('group','supergroup')`),
    check('channels_class_valid', sql`${table.class} IN ('internal','external')`),
    check('channels_language_valid', sql`${table.primaryLanguage} IN ('id','en','auto')`),
    check(
      'channels_status_valid',
      sql`${table.connectionStatus} IN ('draft','verified','active','paused','needs_action')`,
    ),
    check('channels_display_name_length', sql`char_length(${table.displayName}) BETWEEN 1 AND 120`),
    check(
      'channels_monitored_only_when_active',
      sql`NOT ${table.monitored} OR (${table.connectionStatus} = 'active' AND ${table.authorizationAckAt} IS NOT NULL AND ${table.monitoringStartedAt} IS NOT NULL AND ${table.visibleIndicatorMessageId} IS NOT NULL AND (${table.provider} <> 'telegram' OR (${table.providerChatType} IN ('group','supergroup')) IS TRUE))`,
    ),
    uniqueIndex('channels_chat_uq').on(table.workspaceId, table.provider, table.providerChatId),
    index('channels_ws_status_idx').on(table.workspaceId, table.connectionStatus),
  ],
);

export const channelConnectionSessions = pgTable(
  'channel_connection_sessions',
  {
    ...tenantColumns(),
    botConnectionId: reference('bot_connection_id', () => botConnections.id, 'cascade').notNull(),
    createdBy: reference('created_by', () => people.id).notNull(),
    codeHash: bytes('code_hash').notNull(),
    purpose: text('purpose').notNull(),
    credentialVersion: integer('credential_version').default(1).notNull(),
    receivedAt: instant('received_at'),
    candidateChatId: text('candidate_chat_id'),
    candidateTitle: text('candidate_title'),
    candidateChatType: text('candidate_chat_type'),
    expiresAt: instant('expires_at').notNull(),
    consumedAt: instant('consumed_at'),
  },
  (table) => [
    check('ccs_purpose_valid', sql`${table.purpose} IN ('identify_group','receive_check')`),
    check('ccs_expiry_valid', sql`${table.expiresAt} > ${table.createdAt}`),
    uniqueIndex('ccs_hash_uq').on(table.codeHash),
  ],
);

// The one live Telegram invite of a person (FR-TG-12). It sits here because it references the bot.
export const personInvites = pgTable(
  'person_invites',
  {
    ...tenantColumns(),
    personId: reference('person_id', () => people.id).notNull(),
    botConnectionId: reference('bot_connection_id', () => botConnections.id, 'cascade').notNull(),
    codeHash: bytes('code_hash').notNull(),
    expiresAt: instant('expires_at').notNull(),
    consumedAt: instant('consumed_at'),
    createdBy: reference('created_by', () => people.id).notNull(),
  },
  (table) => [
    check('person_invites_expiry_valid', sql`${table.expiresAt} > ${table.createdAt}`),
    uniqueIndex('person_invites_person_uq').on(table.workspaceId, table.personId),
    uniqueIndex('person_invites_hash_uq').on(table.codeHash),
  ],
);

export const channelVerifications = pgTable(
  'channel_verifications',
  {
    ...tenantColumns(),
    channelId: reference('channel_id', () => channels.id, 'cascade').notNull(),
    botConnectionId: reference('bot_connection_id', () => botConnections.id).notNull(),
    configVersion: integer('config_version').notNull(),
    credentialVersion: integer('credential_version').notNull(),
    checks: jsonb('checks').notNull(),
    status: text('status').notNull(),
    checkedAt: instant('checked_at').defaultNow().notNull(),
    expiresAt: instant('expires_at').notNull(),
    errorCode: text('error_code'),
  },
  (table) => [
    check('cv_status_valid', sql`${table.status} IN ('pass','fail','pending')`),
    check('cv_expiry_valid', sql`${table.expiresAt} > ${table.checkedAt}`),
    index('cv_channel_time_idx').on(table.channelId, table.checkedAt.desc()),
  ],
);

export const providerUpdates = pgTable(
  'provider_updates',
  {
    ...joinColumns(),
    botConnectionId: reference('bot_connection_id', () => botConnections.id, 'cascade').notNull(),
    updateId: text('update_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.botConnectionId, table.updateId] })],
);
