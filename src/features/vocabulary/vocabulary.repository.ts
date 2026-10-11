import type { PoolClient } from 'pg';
import type { parseCategory } from './vocabulary.schema.js';
import { DomainError } from '../../platform/errors/domain-error.js';

const duplicateFields: Record<string, string> = {
  vocab_ws_name_uq: 'name',
  vocab_ws_prefix_uq: 'idPrefix',
  aliases_ws_alias_uq: 'alias',
};

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

export async function selectVocabulary(tx: PoolClient, workspaceId: string) {
  const categories = await tx.query(
    'SELECT domain.id, domain.name, domain.description, domain.examples[1] AS example, domain.id_prefix AS "idPrefix", EXISTS(SELECT 1 FROM threads WHERE workspace_id = $1 AND domain_id = domain.id) AS "prefixInUse" FROM vocab_domains AS domain WHERE domain.workspace_id = $1 AND domain.active ORDER BY domain.name',
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
