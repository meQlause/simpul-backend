# Database migrations

`npm run db:generate -- --name=<change>` generates SQL from `src/platform/db/schema/index.ts`.
The journal in `meta/` defines the forward order. Run migrations using the owner connection;
the application role must neither own the tables nor have `BYPASSRLS`.

`0000_vector.sql` installs pgvector before the generated schema uses it.
`0001_schema.sql` is generated. `0002_guarantees.sql` contains the two triggers,
tenant policies and narrowly scoped lookup functions from data-spec §6 and
be-architecture §5. Do not regenerate over these custom migrations. Deployment
grants the application role table access and execution on the three lookup
functions; the functions revoke execution from `PUBLIC`.

Each forward SQL file has a matching file in `down/`. Reverse the journal order
when reverting, executing each corresponding down file in a transaction. The
initial schema rollback removes all foreign keys before dropping the tables so
the workspace/admin-person cycle can be reversed without `CASCADE`.

`npm run test:integration -- tests/integration/platform/db/migrations.test.ts`
exercises forward, reverse and forward again against disposable PostgreSQL 15
with pgvector. Library-owned better-auth and pg-boss tables are installed by
their owners in the phases that introduce those libraries.
