import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DomainError } from '../errors/domain-error.js';

const directory = new URL('../../../drizzle/', import.meta.url);
const migrations = readdirSync(directory)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => {
    const sql = readFileSync(new URL(name, directory), 'utf8');

    return {
      tag: name.replace(/\.sql$/u, ''),
      sql,
      hash: createHash('sha256').update(sql).digest('hex'),
    };
  });

export const schemaVersion = migrations.at(-1)!.tag;

async function applyMigration(
  tx: PoolClient,
  migration: (typeof migrations)[number],
  previous?: { tag: string; hash: string },
) {
  if (previous && previous.hash !== migration.hash) {
    throw new DomainError('E-DB-MIGRATION-FAILED');
  }

  if (!previous) {
    await tx.query(
      migration.sql.replace('CREATE EXTENSION vector;', 'CREATE EXTENSION IF NOT EXISTS vector;'),
    );
    await tx.query('INSERT INTO public.simpul_schema_migrations (tag, hash) VALUES ($1, $2)', [
      migration.tag,
      migration.hash,
    ]);
  }
}

export async function migrateTenant(tx: PoolClient) {
  try {
    await tx.query(`CREATE TABLE IF NOT EXISTS public.simpul_schema_migrations
      (tag text PRIMARY KEY, hash text NOT NULL)`);
    const applied = await tx.query<{ tag: string; hash: string }>(
      'SELECT tag, hash FROM public.simpul_schema_migrations',
    );

    for (const migration of migrations) {
      await applyMigration(
        tx,
        migration,
        applied.rows.find((row) => row.tag === migration.tag),
      );
    }
  } catch {
    throw new DomainError('E-DB-MIGRATION-FAILED');
  }
}
