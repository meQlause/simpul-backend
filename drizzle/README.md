# Database migrations

`npm run db:generate -- --name=<change>` generates SQL from `src/platform/db/schema/index.ts`.
Run every forward `*.sql` file in filename order, including the handwritten files absent
from `meta/_journal.json`. Run migrations using the owner connection;
the application role must neither own the tables nor have `BYPASSRLS`.

`0000_vector.sql` installs pgvector before the generated schema uses it.
`0001_schema.sql` is generated. `0002_guarantees.sql` contains the two triggers,
tenant policies and narrowly scoped lookup functions from data-spec §6 and
be-architecture §5. Do not regenerate over these custom migrations. Deployment
grants the application role table access and execution on `workspace_for_connection(uuid)`,
`workspace_for_session(text)` and `workspace_for_route(uuid)`. Worker and scheduler roles also
need execution on `own_database_workspaces()`, which returns workspace ids and a connection
version derived from the encryption nonce, never a URL or ciphertext. These functions revoke
execution from `PUBLIC`.

Each forward SQL file has a matching file in `down/`. Reverse the filename order
when reverting, executing each corresponding down file in a transaction. The
initial schema rollback removes all foreign keys before dropping the tables so
the workspace/admin-person cycle can be reversed without `CASCADE`.

`npm run test:integration -- tests/integration/platform/db/migrations.test.ts`
exercises forward, reverse and forward again against disposable PostgreSQL 15
with pgvector. Library-owned better-auth and pg-boss tables are installed by
their owners in the phases that introduce those libraries.
