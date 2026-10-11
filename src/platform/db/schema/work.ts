import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  jsonb,
  uuid,
  numeric,
  char,
  integer,
  boolean,
  primaryKey,
  check,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { tenantColumns, joinColumns, reference, instant, people } from './identity.js';
import { channels } from './channels.js';
import { rules, vocabDomains } from './configuration.js';
import { units, messagesRaw } from './messages.js';

export const nodes = pgTable('nodes', {
  ...tenantColumns(),
  type: text('type').notNull(),
  attrs: jsonb('attrs').default({}).notNull(),
});

export const edges = pgTable(
  'edges',
  {
    ...tenantColumns(),
    fromId: reference('from_id', () => nodes.id, 'cascade').notNull(),
    toId: reference('to_id', () => nodes.id, 'cascade').notNull(),
    type: text('type').notNull(),
    weight: numeric('weight', { precision: 6, scale: 4 }).notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    createdBy: text('created_by').notNull(),
  },
  (table) => [
    check(
      'edges_created_by_valid',
      sql`${table.createdBy} IN ('manual','ai_inferred','human_confirmed')`,
    ),
    index('edges_from_idx').on(table.workspaceId, table.fromId, table.type, table.weight.desc()),
    index('edges_to_idx').on(table.workspaceId, table.toId, table.type, table.weight.desc()),
  ],
);

export const threads = pgTable(
  'threads',
  {
    ...tenantColumns(),
    displayId: text('display_id').notNull(),
    status: text('status').notNull(),
    domainId: reference('domain_id', () => vocabDomains.id).notNull(),
    channelId: reference('channel_id', () => channels.id).notNull(),
    customerLabel: text('customer_label'),
    customerNodeId: reference('customer_node_id', () => nodes.id, 'set null'),
    summary: text('summary').notNull(),
    items: jsonb('items').default([]).notNull(),
    ownerPersonId: reference('owner_person_id', () => people.id),
    nextStep: text('next_step'),
    parentThreadId: reference('parent_thread_id', (): AnyPgColumn => threads.id, 'set null'),
    genesisConfidence: numeric('genesis_confidence', { precision: 4, scale: 3 }).notNull(),
    historical: boolean('historical').default(false).notNull(),
    lastActivityAt: instant('last_activity_at').defaultNow().notNull(),
    expiresAt: instant('expires_at'),
    closureKind: text('closure_kind'),
    closureReason: text('closure_reason'),
    closedAt: instant('closed_at'),
    closedBy: reference('closed_by', () => people.id),
  },
  (table) => [
    check(
      'threads_status_valid',
      sql`${table.status} IN ('tentative','active','completed','cancelled','archived')`,
    ),
    check(
      'threads_closure_kind_valid',
      sql`${table.closureKind} IN ('completed','cancelled','outside_chat')`,
    ),
    check(
      'threads_closure_matches_status',
      sql`(${table.status} IN ('tentative','active')) = (${table.closedAt} IS NULL) AND (${table.closedAt} IS NULL) = (${table.closureKind} IS NULL)`,
    ),
    check(
      'threads_tentative_expires',
      sql`${table.status} <> 'tentative' OR ${table.expiresAt} IS NOT NULL`,
    ),
    check(
      'threads_reason_length',
      sql`${table.closureReason} IS NULL OR char_length(${table.closureReason}) BETWEEN 5 AND 300`,
    ),
    uniqueIndex('threads_display_uq').on(table.workspaceId, table.displayId),
    index('threads_candidates_idx').on(
      table.workspaceId,
      table.channelId,
      table.status,
      table.lastActivityAt.desc(),
    ),
    index('threads_expiry_idx').on(table.workspaceId, table.status, table.expiresAt),
    index('threads_list_idx').on(table.workspaceId, table.lastActivityAt.desc()),
  ],
);

export const labels = pgTable(
  'labels',
  {
    ...tenantColumns(),
    unitId: reference('unit_id', () => units.id).notNull(),
    threadId: reference('thread_id', () => threads.id, 'set null'),
    opId: uuid('op_id').defaultRandom().notNull(),
    retractsOpId: reference('retracts_op_id', (): AnyPgColumn => labels.opId),
    retractedAt: instant('retracted_at'),
    domainId: reference('domain_id', () => vocabDomains.id),
    domainHint: text('domain_hint'),
    type: text('type').notNull(),
    tense: text('tense').notNull(),
    magnitude: numeric('magnitude', { precision: 18, scale: 2 }),
    currency: char('currency', { length: 3 }),
    actorFrom: reference('actor_from', () => people.id),
    actorTo: reference('actor_to', () => people.id),
    evidenceMessageIds: uuid('evidence_message_ids').array().notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),
    vocabVersion: integer('vocab_version').notNull(),
    routedAt: instant('routed_at'),
  },
  (table) => [
    check('labels_type_valid', sql`${table.type} IN ('progress','resolution','blocker')`),
    check('labels_tense_valid', sql`${table.tense} IN ('sudah_terjadi','rencana','kondisional')`),
    check('labels_evidence_required', sql`cardinality(${table.evidenceMessageIds}) >= 1`),
    check('labels_confidence_valid', sql`${table.confidence} BETWEEN 0 AND 1`),
    check(
      'labels_currency_with_magnitude',
      sql`(${table.magnitude} IS NULL) = (${table.currency} IS NULL)`,
    ),
    index('labels_unrouted_idx')
      .on(table.workspaceId, table.routedAt)
      .where(sql`${table.routedAt} IS NULL`),
    uniqueIndex('labels_op_uq').on(table.opId),
    index('labels_thread_idx').on(table.threadId),
  ],
);

export const labelRuleMatches = pgTable(
  'label_rule_matches',
  {
    ...joinColumns(),
    labelId: reference('label_id', () => labels.id, 'cascade').notNull(),
    ruleId: reference('rule_id', () => rules.id).notNull(),
    matchedAt: instant('matched_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.labelId, table.ruleId] }),
    index('lrm_rule_time_idx').on(table.ruleId, table.matchedAt.desc()),
  ],
);

export const progressMarkers = pgTable(
  'progress_markers',
  {
    ...tenantColumns(),
    threadId: reference('thread_id', () => threads.id, 'cascade').notNull(),
    ts: instant('ts').notNull(),
    text: text('text').notNull(),
    messageId: reference('message_id', () => messagesRaw.id, 'set null'),
    type: text('type').notNull(),
    opId: reference('op_id', () => labels.opId),
    previousState: jsonb('previous_state'),
    retractedAt: instant('retracted_at'),
    confirmedBy: reference('confirmed_by', () => people.id),
    confirmationId: text('confirmation_id'),
  },
  (table) => [
    check('markers_type_valid', sql`${table.type} IN ('progress','resolution','blocker')`),
    index('markers_thread_ts_idx').on(table.threadId, table.ts.desc()),
    uniqueIndex('markers_op_uq').on(table.opId),
  ],
);

export const messageThreadLink = pgTable(
  'message_thread_link',
  {
    ...joinColumns(),
    messageId: reference('message_id', () => messagesRaw.id).notNull(),
    threadId: reference('thread_id', () => threads.id, 'cascade').notNull(),
    role: text('role').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.threadId, table.role] }),
    check(
      'mtl_role_valid',
      sql`${table.role} IN ('genesis','state_change','mention','supporting')`,
    ),
    index('mtl_message_idx').on(table.messageId),
  ],
);
