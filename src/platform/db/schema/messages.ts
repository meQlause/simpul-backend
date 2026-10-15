import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  boolean,
  date,
  numeric,
  vector,
  primaryKey,
  check,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { tenantColumns, joinColumns, reference, instant, people } from './identity.js';
import { channels } from './channels.js';

export const messagesRaw = pgTable(
  'messages_raw',
  {
    ...tenantColumns(),
    channelId: reference('channel_id', () => channels.id).notNull(),
    providerMsgId: text('provider_msg_id').notNull(),
    senderExternalId: text('sender_external_id').notNull(),
    body: text('body').default('').notNull(),
    bodySafe: text('body_safe').default('').notNull(),
    mediaRef: text('media_ref'),
    replyToId: text('reply_to_id'),
    threadRef: text('thread_ref'),
    serverTs: instant('server_ts').notNull(),
    receivedTs: instant('received_ts').notNull(),
    origin: text('origin').default('user').notNull(),
    supersedes: reference('supersedes', (): AnyPgColumn => messagesRaw.id, 'set null'),
  },
  (table) => [
    check('messages_origin_valid', sql`${table.origin} IN ('user','simpul')`),
    uniqueIndex('messages_provider_uq').on(table.workspaceId, table.channelId, table.providerMsgId),
    index('messages_sweep_idx').on(table.workspaceId, table.channelId, table.serverTs.desc()),
  ],
);

export const units = pgTable(
  'units',
  {
    ...tenantColumns(),
    channelId: reference('channel_id', () => channels.id).notNull(),
    senderId: reference('sender_id', () => people.id),
    text: text('text').notNull(),
    explicitIds: text('explicit_ids')
      .array()
      .default(sql`'{}'`)
      .notNull(),
    triageClass: text('triage_class'),
    urgency: text('urgency').default('normal').notNull(),
    injectionSuspected: boolean('injection_suspected').default(false).notNull(),
    referencedDate: date('referenced_date'),
    source: text('source').default('text').notNull(),
    confidenceMultiplier: numeric('confidence_multiplier', { precision: 3, scale: 2 })
      .default('1.00')
      .notNull(),
    tsFirst: instant('ts_first').notNull(),
    tsLast: instant('ts_last').notNull(),
  },
  (table) => [
    check('units_triage_valid', sql`${table.triageClass} IN ('EVENT','QUERY','NOISE')`),
    check('units_source_valid', sql`${table.source} IN ('text','transcript')`),
    check('units_confidence_valid', sql`${table.confidenceMultiplier} BETWEEN 0 AND 1`),
    check('units_time_order', sql`${table.tsLast} >= ${table.tsFirst}`),
    index('units_ws_time_idx')
      .on(table.workspaceId, table.tsLast.desc())
      .where(sql`${table.triageClass} <> 'NOISE'`),
  ],
);

export const mediaOutcomes = pgTable(
  'media_outcomes',
  {
    ...joinColumns(),
    messageId: reference('message_id', () => messagesRaw.id, 'cascade').primaryKey(),
    outcome: text('outcome').notNull(),
  },
  (table) => [check('media_outcome_valid', sql`${table.outcome} IN ('transcript','unread')`)],
);

export const unitMessages = pgTable(
  'unit_messages',
  {
    ...joinColumns(),
    unitId: reference('unit_id', () => units.id, 'cascade').notNull(),
    messageId: reference('message_id', () => messagesRaw.id).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.unitId, table.messageId] }),
    index('unit_messages_msg_idx').on(table.messageId),
  ],
);

export const unitEmbeddings = pgTable(
  'unit_embeddings',
  {
    ...joinColumns(),
    unitId: reference('unit_id', () => units.id, 'cascade').primaryKey(),
    embedding: vector('embedding', { dimensions: 768 }).notNull(),
    model: text('model').notNull(),
  },
  (table) => [
    index('unit_embeddings_hnsw_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
  ],
);
