import type { PoolClient } from 'pg';
import { DomainError } from '../errors/domain-error.js';

const columns = `SELECT child.relname AS child, parent.relname AS parent, ca.attname AS "childColumn", pa.attname AS "parentColumn"
  FROM pg_constraint fk JOIN pg_class child ON child.oid = fk.conrelid JOIN pg_namespace cs ON cs.oid = child.relnamespace
  JOIN pg_class parent ON parent.oid = fk.confrelid JOIN pg_namespace ps ON ps.oid = parent.relnamespace
  JOIN pg_attribute ca ON ca.attrelid = child.oid AND ca.attnum = fk.conkey[1]
  JOIN pg_attribute pa ON pa.attrelid = parent.oid AND pa.attnum = fk.confkey[1]
  WHERE fk.contype = 'f' AND cs.nspname = 'public' AND ps.nspname = 'public'
    AND cardinality(fk.conkey) = 1 AND cardinality(fk.confkey) = 1
    AND (child.relname = 'workspaces' OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = child.oid AND a.attname = 'workspace_id'))
    AND (parent.relname = 'workspaces' OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = parent.oid AND a.attname = 'workspace_id'))`;

function identifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

export async function guardForeignReferences(tx: PoolClient, workspaceId: string) {
  const references = await tx.query<{
    child: string;
    parent: string;
    childColumn: string;
    parentColumn: string;
  }>(columns);

  for (const reference of references.rows) {
    const childScope = reference.child === 'workspaces' ? 'id' : 'workspace_id';
    const parentScope = reference.parent === 'workspaces' ? 'id' : 'workspace_id';
    const result = await tx.query(
      `SELECT 1 FROM ${identifier(reference.child)} child JOIN ${identifier(reference.parent)} parent
      ON child.${identifier(reference.childColumn)} = parent.${identifier(reference.parentColumn)}
      WHERE child.${identifier(childScope)} <> $1 AND parent.${identifier(parentScope)} = $1 LIMIT 1`,
      [workspaceId],
    );

    if (result.rowCount) {
      throw new DomainError('E-FORBIDDEN');
    }
  }
}
