import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  boolean,
  integer,
  uuid,
  jsonb,
  check,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { tenantColumns, joinColumns, reference, instant, bytes, people } from './identity.js';
import { channels } from './channels.js';
import { rules } from './configuration.js';
import { units } from './messages.js';
import { labels, threads } from './work.js';

export const digests = pgTable('digests', {
  ...tenantColumns(),
  recipientPersonId: reference('recipient_person_id', () => people.id).notNull(),
  scheduledFor: instant('scheduled_for').notNull(),
  sentAt: instant('sent_at'),
});

export const digestItems = pgTable(
  'digest_items',
  {
    ...joinColumns(),
    digestId: reference('digest_id', () => digests.id, 'cascade').notNull(),
    labelId: reference('label_id', () => labels.id, 'cascade').notNull(),
    ruleId: reference('rule_id', () => rules.id).notNull(),
  },
  (table) => [uniqueIndex('digest_items_label_uq').on(table.digestId, table.labelId)],
);

export const notifications = pgTable(
  'notifications',
  {
    ...tenantColumns(),
    labelId: reference('label_id', () => labels.id),
    threadId: reference('thread_id', () => threads.id, 'set null'),
    ruleId: reference('rule_id', () => rules.id),
    recipientPersonId: reference('recipient_person_id', () => people.id),
    destinationChannelId: reference('destination_channel_id', () => channels.id),
    kind: text('kind').default('update').notNull(),
    channel: text('channel').notNull(),
    bodyRendered: text('body_rendered').notNull(),
    digestId: reference('digest_id', () => digests.id, 'set null'),
    heldUntil: instant('held_until').notNull(),
    sentAt: instant('sent_at'),
    cancelledAt: instant('cancelled_at'),
    correctedAt: instant('corrected_at'),
    staleSince: instant('stale_since'),
    failedAt: instant('failed_at'),
    failureReason: text('failure_reason'),
  },
  (table) => [
    check('notif_failure_reason_valid', sql`${table.failureReason} IN ('recipient_unreachable')`),
    check(
      'notif_failed_alone',
      sql`(${table.failedAt} IS NULL) = (${table.failureReason} IS NULL) AND (${table.failedAt} IS NULL OR (${table.sentAt} IS NULL AND ${table.cancelledAt} IS NULL))`,
    ),
    check(
      'notifications_source_valid',
      sql`${table.labelId} IS NOT NULL OR (${table.kind} IN ('reminder','escalation') AND ${table.threadId} IS NOT NULL)`,
    ),
    check(
      'notifications_exactly_one_destination',
      sql`(${table.recipientPersonId} IS NULL) <> (${table.destinationChannelId} IS NULL)`,
    ),
    check(
      'notifications_kind_valid',
      sql`${table.kind} IN ('update','reminder','escalation','correction')`,
    ),
    check('notifications_channel_valid', sql`${table.channel} IN ('telegram','fake','email')`),
    check(
      'notifications_not_sent_and_cancelled',
      sql`NOT (${table.sentAt} IS NOT NULL AND ${table.cancelledAt} IS NOT NULL)`,
    ),
    index('notif_due_idx')
      .on(table.workspaceId, table.heldUntil)
      .where(sql`${table.sentAt} IS NULL AND ${table.cancelledAt} IS NULL`),
    index('notif_budget_idx').on(table.recipientPersonId, table.sentAt.desc()),
    index('notif_rule_idx').on(table.ruleId, table.sentAt.desc()),
    uniqueIndex('notif_one_per_label_uq')
      .on(table.labelId, table.recipientPersonId, table.kind)
      .where(sql`${table.cancelledAt} IS NULL AND ${table.kind} IN ('update','correction')`),
    uniqueIndex('notif_one_per_label_channel_uq')
      .on(table.labelId, table.destinationChannelId, table.kind)
      .where(sql`${table.cancelledAt} IS NULL AND ${table.kind} IN ('update','correction')`),
    uniqueIndex('notif_silence_cycle_uq')
      .on(table.workspaceId, table.threadId, table.kind, table.staleSince)
      .where(sql`${table.kind} IN ('reminder','escalation') AND ${table.cancelledAt} IS NULL`),
  ],
);

export const corrections = pgTable(
  'corrections',
  {
    ...tenantColumns(),
    opId: uuid('op_id').notNull(),
    notificationId: reference('notification_id', () => notifications.id).notNull(),
    correctedBy: reference('corrected_by', () => people.id).notNull(),
    correctionType: text('correction_type').notNull(),
    previousState: jsonb('previous_state').notNull(),
  },
  (table) => [
    check('corrections_type_valid', sql`${table.correctionType} = 'not_this_work'`),
    index('corrections_op_idx').on(table.opId),
  ],
);

export const openQuestions = pgTable(
  'open_questions',
  {
    ...tenantColumns(),
    unitId: reference('unit_id', () => units.id, 'cascade'),
    threadIds: uuid('thread_ids').array().notNull(),
    channelId: reference('channel_id', () => channels.id).notNull(),
    askedAt: instant('asked_at').defaultNow().notNull(),
    expiresAt: instant('expires_at').notNull(),
    answeredBy: reference('answered_by', () => people.id),
    answer: text('answer'),
  },
  (table) => [
    uniqueIndex('oq_unit_uq').on(table.unitId),
    check('oq_candidates_valid', sql`cardinality(${table.threadIds}) BETWEEN 1 AND 3`),
    check('oq_expiry_valid', sql`${table.expiresAt} > ${table.askedAt}`),
    index('oq_channel_day_idx').on(table.channelId, table.askedAt.desc()),
  ],
);

export const unitResolutions = pgTable(
  'unit_resolutions',
  {
    ...joinColumns(),
    unitId: reference('unit_id', () => units.id, 'cascade').primaryKey(),
    verdict: text('verdict').notNull(),
    decidedBy: text('decided_by').notNull(),
    candidates: jsonb('candidates')
      .default(sql`'[]'::jsonb`)
      .notNull(),
    chosenThreadId: reference('chosen_thread_id', () => threads.id, 'set null'),
    contextMessageCount: integer('context_message_count').default(0).notNull(),
    searchQuery: text('search_query'),
    searchHits: integer('search_hits'),
  },
  (table) => [
    check('unit_resolutions_verdict_valid', sql`${table.verdict} IN ('ATTACH', 'GREY', 'CREATE')`),
    check(
      'unit_resolutions_decided_valid',
      sql`${table.decidedBy} IN ('score', 'reference', 'model_context', 'question', 'admin', 'search')`,
    ),
    check('unit_resolutions_candidates_valid', sql`jsonb_array_length(${table.candidates}) <= 3`),
    check('unit_resolutions_context_valid', sql`${table.contextMessageCount} >= 0`),
  ],
);

export const orphans = pgTable(
  'orphans',
  {
    ...tenantColumns(),
    unitId: reference('unit_id', () => units.id, 'cascade').notNull(),
    reason: text('reason').notNull(),
    recoverable: boolean('recoverable').default(true).notNull(),
    clusterKey: text('cluster_key'),
    closedAt: instant('closed_at'),
  },
  (table) => [
    index('orphans_open_idx')
      .on(table.workspaceId, table.createdAt)
      .where(sql`${table.closedAt} IS NULL`),
  ],
);

export const unitCorrections = pgTable(
  'unit_corrections',
  {
    ...tenantColumns(),
    unitId: reference('unit_id', () => units.id, 'cascade').notNull(),
    action: text('action').notNull(),
    threadId: reference('thread_id', () => threads.id, 'cascade').notNull(),
    previousOutcome: text('previous_outcome').notNull(),
    correctedBy: reference('corrected_by', () => people.id).notNull(),
  },
  (table) => [
    check('unit_corrections_action_valid', sql`${table.action} IN ('create', 'attach')`),
    index('unit_corrections_unit_idx').on(table.workspaceId, table.unitId, table.createdAt.desc()),
  ],
);

export const messageAccessLog = pgTable(
  'message_access_log',
  {
    ...tenantColumns(),
    personId: reference('person_id', () => people.id).notNull(),
    channelId: reference('channel_id', () => channels.id, 'cascade').notNull(),
    accessedAt: instant('accessed_at').defaultNow().notNull(),
  },
  (table) => [
    index('message_access_log_ws_time_idx').on(table.workspaceId, table.accessedAt.desc()),
  ],
);

export const reviewItems = pgTable(
  'review_items',
  {
    ...tenantColumns(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    detail: text('detail').notNull(),
    channelId: reference('channel_id', () => channels.id).notNull(),
    labelId: reference('label_id', () => labels.id, 'set null'),
    detectedText: text('detected_text'),
    detectedAt: instant('detected_at').defaultNow().notNull(),
    resolvedAt: instant('resolved_at'),
    resolvedBy: reference('resolved_by', () => people.id),
  },
  (table) => [
    check('review_kind_valid', sql`${table.kind} IN ('unrouted','alias','category')`),
    index('review_open_idx')
      .on(table.workspaceId, table.kind, table.detectedAt.desc())
      .where(sql`${table.resolvedAt} IS NULL`),
  ],
);

export const decisions = pgTable(
  'decisions',
  {
    ...tenantColumns(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    detail: text('detail').notNull(),
    occurredAt: instant('occurred_at').defaultNow().notNull(),
    threadId: reference('thread_id', () => threads.id, 'set null'),
    ruleId: reference('rule_id', () => rules.id, 'set null'),
    recipientPersonId: reference('recipient_person_id', () => people.id, 'set null'),
    notificationId: reference('notification_id', () => notifications.id, 'set null'),
  },
  (table) => [
    check('decisions_kind_valid', sql`${table.kind} IN ('routing','work','queue','digest')`),
    index('decisions_list_idx').on(table.workspaceId, table.occurredAt.desc()),
  ],
);

export const configAudit = pgTable(
  'config_audit',
  {
    ...tenantColumns(),
    actorId: reference('actor_id', () => people.id).notNull(),
    tableName: text('table_name').notNull(),
    recordId: uuid('record_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
  },
  (table) => [
    index('audit_record_idx').on(
      table.workspaceId,
      table.tableName,
      table.recordId,
      table.createdAt.desc(),
    ),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    ...tenantColumns(),
    key: text('key').notNull(),
    endpoint: text('endpoint').notNull(),
    fingerprint: bytes('fingerprint').notNull(),
    response: jsonb('response'),
    outcome: jsonb('outcome'),
  },
  (table) => [uniqueIndex('idem_uq').on(table.workspaceId, table.endpoint, table.key)],
);
