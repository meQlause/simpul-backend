import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  time,
  numeric,
  boolean,
  check,
  index,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { tenantColumns, joinColumns, reference, instant, people, roles } from './identity.js';

const DEFAULT_BUDGET_PER_HOUR = 6;
const DEFAULT_HOLD_SECONDS = 60;

export const policies = pgTable(
  'policies',
  {
    ...tenantColumns(),
    budgetPerHour: integer('budget_per_hour').default(DEFAULT_BUDGET_PER_HOUR).notNull(),
    quietStart: time('quiet_start', { precision: 0 }).default('21:00').notNull(),
    quietEnd: time('quiet_end', { precision: 0 }).default('07:00').notNull(),
    digestTime: time('digest_time', { precision: 0 }).notNull(),
    holdSeconds: integer('hold_seconds').default(DEFAULT_HOLD_SECONDS).notNull(),
    escalationLimit: integer('escalation_limit').default(1).notNull(),
  },
  (table) => [
    uniqueIndex('policies_ws_uq').on(table.workspaceId),
    check('policies_budget_valid', sql`${table.budgetPerHour} BETWEEN 1 AND 50`),
    check('policies_hold_nonnegative', sql`${table.holdSeconds} >= 0`),
    check('policies_escalation_nonnegative', sql`${table.escalationLimit} >= 0`),
  ],
);

export const vocabDomains = pgTable(
  'vocab_domains',
  {
    ...tenantColumns(),
    name: text('name').notNull(),
    description: text('description'),
    examples: text('examples')
      .array()
      .default(sql`'{}'`)
      .notNull(),
    idPrefix: text('id_prefix'),
    active: boolean('active').default(true).notNull(),
  },
  (table) => [
    check('vocab_name_length', sql`char_length(${table.name}) BETWEEN 1 AND 80`),
    check('vocab_description_length', sql`char_length(${table.description}) <= 300`),
    check('vocab_prefix_valid', sql`${table.idPrefix} ~ '^[A-Z]{3}$'`),
    uniqueIndex('vocab_ws_name_uq').on(table.workspaceId, sql`lower(${table.name})`),
    uniqueIndex('vocab_ws_prefix_uq')
      .on(table.workspaceId, table.idPrefix)
      .where(sql`${table.idPrefix} IS NOT NULL`),
  ],
);

export const thresholds = pgTable(
  'thresholds',
  {
    ...tenantColumns(),
    scope: text('scope').default('workspace').notNull(),
    scopeId: reference('scope_id', () => vocabDomains.id),
    key: text('key').notNull(),
    value: numeric('value', { precision: 12, scale: 4 }).notNull(),
  },
  (table) => [
    check('thresholds_scope_valid', sql`${table.scope} IN ('workspace','domain')`),
    unique('thresholds_uq')
      .on(table.workspaceId, table.scope, table.scopeId, table.key)
      .nullsNotDistinct(),
  ],
);

export const aliases = pgTable(
  'aliases',
  {
    ...tenantColumns(),
    alias: text('alias').notNull(),
    personId: reference('person_id', () => people.id).notNull(),
    source: text('source').default('manual').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
  },
  (table) => [
    check('aliases_alias_length', sql`char_length(${table.alias}) BETWEEN 1 AND 80`),
    check(
      'aliases_source_valid',
      sql`${table.source} IN ('manual','ai_inferred','human_confirmed')`,
    ),
    check('aliases_confidence_valid', sql`${table.confidence} BETWEEN 0 AND 1`),
    uniqueIndex('aliases_ws_alias_uq').on(table.workspaceId, sql`lower(${table.alias})`),
  ],
);

export const templates = pgTable(
  'templates',
  {
    ...tenantColumns(),
    key: text('key').notNull(),
    audience: text('audience').notNull(),
    body: text('body').notNull(),
    editable: boolean('editable').default(true).notNull(),
  },
  (table) => [
    check('templates_body_length', sql`char_length(${table.body}) <= 300`),
    check('templates_audience_valid', sql`${table.audience} IN ('internal','external')`),
    check(
      'templates_placeholders_allowed',
      sql`regexp_replace(${table.body}, '\{\{(work_id|customer|summary)\}\}', '', 'g') !~ '\{\{'`,
    ),
    uniqueIndex('templates_uq').on(table.workspaceId, table.key, table.audience),
  ],
);

export const displayIdCounters = pgTable('display_id_counters', {
  ...joinColumns(),
  domainId: reference('domain_id', () => vocabDomains.id).primaryKey(),
  lastValue: integer('last_value').default(0).notNull(),
});

export const rules = pgTable(
  'rules',
  {
    ...tenantColumns(),
    name: text('name').notNull(),
    domainId: reference('domain_id', () => vocabDomains.id).notNull(),
    conditionText: text('condition_text').notNull(),
    eventType: text('event_type').notNull(),
    recipientRoleId: reference('recipient_role_id', () => roles.id).notNull(),
    templateId: reference('template_id', () => templates.id).notNull(),
    urgency: text('urgency').default('normal').notNull(),
    priority: integer('priority').default(0).notNull(),
    historyMode: text('history_mode').default('digest').notNull(),
    active: boolean('active').default(true).notNull(),
    lastFiredAt: instant('last_fired_at'),
  },
  (table) => [
    check('rules_name_length', sql`char_length(${table.name}) BETWEEN 1 AND 100`),
    check('rules_condition_length', sql`char_length(${table.conditionText}) BETWEEN 1 AND 300`),
    check(
      'rules_event_type_valid',
      sql`${table.eventType} IN ('new','progress','resolution','blocker')`,
    ),
    check('rules_urgency_valid', sql`${table.urgency} IN ('normal','high')`),
    check('rules_history_mode_valid', sql`${table.historyMode} IN ('digest','future')`),
    index('rules_ws_active_idx').on(table.workspaceId, table.active, table.priority.desc()),
  ],
);
