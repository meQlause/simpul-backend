import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  boolean,
  check,
  index,
  uniqueIndex,
  primaryKey,
  customType,
  timestamp,
  uuid,
  integer,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const instant = (name: string) => timestamp(name, { withTimezone: true });
export const bytes = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
export const reference = (
  name: string,
  target: () => AnyPgColumn,
  onDelete: 'restrict' | 'cascade' | 'set null' = 'restrict',
) => uuid(name).references(target, { onDelete, onUpdate: 'restrict' });
export const rowColumns = () => ({
  id: uuid('id').defaultRandom().primaryKey(),
  createdAt: instant('created_at').defaultNow().notNull(),
});

export const workspaces = pgTable(
  'workspaces',
  {
    ...rowColumns(),
    name: text('name').notNull(),
    descriptor: text('descriptor'),
    timezone: text('timezone').notNull(),
    vocabVersion: integer('vocab_version').default(1).notNull(),
    adminPersonId: reference('admin_person_id', (): AnyPgColumn => people.id),
    onboardingCompletedAt: instant('onboarding_completed_at'),
  },
  (table) => [
    check('workspaces_name_length', sql`char_length(${table.name}) BETWEEN 1 AND 80`),
    check('workspaces_vocab_version_positive', sql`${table.vocabVersion} >= 1`),
  ],
);

export const joinColumns = () => ({
  createdAt: instant('created_at').defaultNow().notNull(),
  workspaceId: reference('workspace_id', (): AnyPgColumn => workspaces.id).notNull(),
});
export const tenantColumns = () => ({ ...rowColumns(), ...joinColumns() });

export const people = pgTable(
  'people',
  {
    ...tenantColumns(),
    name: text('name').notNull(),
    email: text('email'),
    level: text('level').default('staff').notNull(),
    managerId: reference('manager_id', (): AnyPgColumn => people.id, 'set null'),
    availability: text('availability').default('available').notNull(),
    active: boolean('active').default(true).notNull(),
    authUserId: text('auth_user_id'),
  },
  (table) => [
    check('people_name_length', sql`char_length(${table.name}) BETWEEN 1 AND 120`),
    check('people_level_valid', sql`${table.level} IN ('staff','executive')`),
    check('people_availability_valid', sql`${table.availability} IN ('available','leave')`),
    check('people_manager_not_self', sql`${table.managerId} <> ${table.id}`),
    index('people_ws_name_idx').on(table.workspaceId, sql`lower(${table.name})`),
    uniqueIndex('people_auth_user_uq')
      .on(table.authUserId)
      .where(sql`${table.authUserId} IS NOT NULL`),
  ],
);

export const personIdentities = pgTable(
  'person_identities',
  {
    ...tenantColumns(),
    personId: reference('person_id', () => people.id).notNull(),
    provider: text('provider').notNull(),
    externalId: text('external_id'),
    handle: text('handle'),
  },
  (table) => [
    check('identities_provider_valid', sql`${table.provider} = 'telegram'`),
    check(
      'identities_identifier_required',
      sql`${table.externalId} IS NOT NULL OR ${table.handle} IS NOT NULL`,
    ),
    uniqueIndex('identities_person_provider_uq').on(table.personId, table.provider),
    uniqueIndex('identities_external_uq')
      .on(table.workspaceId, table.provider, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
  ],
);

export const roles = pgTable(
  'roles',
  {
    ...tenantColumns(),
    roleKey: text('role_key').notNull(),
    name: text('name').notNull(),
    team: text('team').default('Other').notNull(),
    active: boolean('active').default(true).notNull(),
  },
  (table) => [
    check('roles_name_length', sql`char_length(${table.name}) BETWEEN 1 AND 60`),
    uniqueIndex('roles_ws_key_uq').on(table.workspaceId, table.roleKey),
  ],
);

export const roleMembers = pgTable(
  'role_members',
  {
    ...joinColumns(),
    roleId: reference('role_id', () => roles.id, 'cascade').notNull(),
    personId: reference('person_id', () => people.id).notNull(),
    kind: text('kind').default('member').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.personId, table.kind] }),
    check('role_members_kind_valid', sql`${table.kind} IN ('member','backup')`),
    index('role_members_person_idx').on(table.personId, table.kind),
  ],
);
