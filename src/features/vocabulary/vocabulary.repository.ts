import type { PoolClient } from 'pg';
import type { parseCategory, parseCategoryEdit } from './vocabulary.schema.js';
import { DomainError } from '../../platform/errors/domain-error.js';

const duplicateFields: Record<string, string> = {
  vocab_ws_name_uq: 'name',
  vocab_ws_prefix_uq: 'idPrefix',
  aliases_ws_alias_uq: 'alias',
};

export async function selectModelCategories(tx: PoolClient, workspaceId: string) {
  return (
    await tx.query<{ id: string; name: string }>(
      'SELECT id, name FROM vocab_domains WHERE workspace_id = $1 AND active ORDER BY name, id',
      [workspaceId],
    )
  ).rows;
}

export async function activeCategory(tx: PoolClient, workspaceId: string, id: string) {
  const result = await tx.query(
    'SELECT id FROM vocab_domains WHERE workspace_id = $1 AND id = $2 AND active',
    [workspaceId, id],
  );

  return result.rowCount === 1;
}

export async function configurationWrite<Result>(operation: () => Promise<Result>) {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === '23505' &&
      'constraint' in error &&
      typeof error.constraint === 'string'
    ) {
      throw new DomainError('E-VALIDATION', [
        { field: duplicateFields[error.constraint] ?? 'name', issue: 'duplicate' },
      ]);
    }

    throw error;
  }
}

export async function insertCategory(
  tx: PoolClient,
  workspaceId: string,
  input: ReturnType<typeof parseCategory>,
) {
  const result = await tx.query<{ id: string }>(
    'INSERT INTO vocab_domains (workspace_id, name, description, examples, id_prefix) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [workspaceId, input.name, input.description, [input.example], input.idPrefix],
  );
  const id = result.rows[0].id;

  await tx.query('INSERT INTO display_id_counters (workspace_id, domain_id) VALUES ($1, $2)', [
    workspaceId,
    id,
  ]);

  return { id, ...input, prefixInUse: false };
}

export async function insertAlias(
  tx: PoolClient,
  workspaceId: string,
  alias: string,
  person: { id: string; name: string },
) {
  const result = await tx.query<{ id: string }>(
    'INSERT INTO aliases (workspace_id, alias, person_id) VALUES ($1, $2, $3) RETURNING id',
    [workspaceId, alias, person.id],
  );

  return { id: result.rows[0].id, alias, person: { id: person.id, name: person.name } };
}

export async function reuseAlias(
  tx: PoolClient,
  workspaceId: string,
  alias: string,
  personId: string,
) {
  const result = await tx.query<{ id: string; inserted: boolean }>(
    'INSERT INTO aliases (workspace_id, alias, person_id) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, lower(alias)) DO UPDATE SET alias = aliases.alias WHERE aliases.person_id = EXCLUDED.person_id RETURNING id, (xmax = 0) AS inserted',
    [workspaceId, alias, personId],
  );

  return result.rows[0];
}

export async function selectVocabulary(tx: PoolClient, workspaceId: string) {
  const categories = await tx.query(
    'SELECT domain.id, domain.name, domain.description, domain.examples[1] AS example, domain.id_prefix AS "idPrefix", (EXISTS(SELECT 1 FROM display_id_counters WHERE workspace_id = $1 AND domain_id = domain.id AND last_value > 0) OR EXISTS(SELECT 1 FROM threads WHERE workspace_id = $1 AND domain_id = domain.id)) AS "prefixInUse" FROM vocab_domains AS domain WHERE domain.workspace_id = $1 AND domain.active ORDER BY domain.name',
    [workspaceId],
  );
  const aliases = await tx.query(
    "SELECT alias.id, alias.alias, jsonb_build_object('id', person.id, 'name', person.name) AS person FROM aliases AS alias JOIN people AS person ON person.id = alias.person_id AND person.workspace_id = $1 WHERE alias.workspace_id = $1 ORDER BY alias.alias",
    [workspaceId],
  );
  const templates = await tx.query<{ audience: string; body: string }>(
    "SELECT audience, body FROM templates WHERE workspace_id = $1 AND key = 'update' ORDER BY audience",
    [workspaceId],
  );

  return {
    categories: categories.rows,
    aliases: aliases.rows,
    templates: Object.fromEntries(templates.rows.map((row) => [row.audience, { body: row.body }])),
  };
}

export async function lockInternalTemplate(tx: PoolClient, workspaceId: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    workspaceId + ':internal-template',
  ]);

  return (
    await tx.query<{ id: string; body: string }>(
      "SELECT id, body FROM templates WHERE workspace_id = $1 AND key = 'update' AND audience = 'internal' FOR UPDATE",
      [workspaceId],
    )
  ).rows[0];
}

export async function storeInternalTemplate(tx: PoolClient, workspaceId: string, body: string) {
  return (
    await tx.query<{ id: string; body: string }>(
      "INSERT INTO templates (workspace_id, key, audience, body, editable) VALUES ($1, 'update', 'internal', $2, true) ON CONFLICT (workspace_id, key, audience) DO UPDATE SET body = EXCLUDED.body RETURNING id, body",
      [workspaceId, body],
    )
  ).rows[0];
}

type Category = {
  id: string;
  name: string;
  description: string | null;
  example: string | null;
  idPrefix: string | null;
  prefixInUse: boolean;
};

export async function lockCategory(tx: PoolClient, workspaceId: string, id: string) {
  await tx.query('SELECT id FROM vocab_domains WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
    workspaceId,
    id,
  ]);

  return (
    await tx.query<Category>(
      'SELECT domain.id, domain.name, domain.description, domain.examples[1] AS example, domain.id_prefix AS "idPrefix", (EXISTS(SELECT 1 FROM display_id_counters WHERE workspace_id = $1 AND domain_id = domain.id AND last_value > 0) OR EXISTS(SELECT 1 FROM threads WHERE workspace_id = $1 AND domain_id = domain.id)) AS "prefixInUse" FROM vocab_domains AS domain WHERE domain.workspace_id = $1 AND domain.id = $2',
      [workspaceId, id],
    )
  ).rows[0];
}

export async function editCategory(
  tx: PoolClient,
  workspaceId: string,
  id: string,
  input: ReturnType<typeof parseCategoryEdit>,
) {
  await tx.query(
    'UPDATE vocab_domains SET description = COALESCE($3, description), examples = CASE WHEN $4::text IS NULL THEN examples ELSE ARRAY[$4] || COALESCE(examples[2:array_length(examples, 1)], ARRAY[]::text[]) END, id_prefix = COALESCE($5, id_prefix) WHERE workspace_id = $1 AND id = $2',
    [workspaceId, id, input.description, input.example, input.idPrefix],
  );
}

export async function incrementDisplayCounter(
  tx: PoolClient,
  workspaceId: string,
  domainId: string,
) {
  return (
    await tx.query<{ value: number }>(
      'INSERT INTO display_id_counters (workspace_id, domain_id, last_value) VALUES ($1, $2, 1) ON CONFLICT (domain_id) DO UPDATE SET last_value = display_id_counters.last_value + 1 WHERE display_id_counters.workspace_id = $1 RETURNING last_value AS value',
      [workspaceId, domainId],
    )
  ).rows[0].value;
}
