# Database migrations

`npm run db:generate -- --name=<change>` generates SQL from `src/platform/db/schema/index.ts`.
Run every forward `*.sql` file in filename order, including the handwritten files absent
from `meta/_journal.json`. Run migrations using the owner connection;
the application role must neither own the tables nor have `BYPASSRLS`.

Build, then run `npm run db:migrate` before starting the application processes. The command
uses `DATABASE_MIGRATION_URL` for the system database first, then visits connected own
databases using their stored credentials. It checks the workspace identity, migrates each
customer transactionally, and records its full schema tag. One customer failure commits
`migration_failed`, sends its admin a system notice, continues with the others and causes
exit status 1. SMTP failure cannot undo the recorded migration failure.

The migration ledger rejects changed hashes and unknown future tags. Fresh system databases
are initialized by this command. Existing schemas installed manually without the ledger
require an operator-verified baseline before adoption; the command does not guess which
migrations ran or replay destructive schema creation over existing tables.

`0000_vector.sql` installs pgvector before the generated schema uses it.
`0001_schema.sql` is generated. `0002_guarantees.sql` contains the two triggers,
tenant policies and narrowly scoped lookup functions from data-spec §6 and
be-architecture §5. Do not regenerate over these custom migrations. Deployment
grants the application role table access and execution on `workspace_for_connection(uuid)`,
`workspace_for_session(text)` and `workspace_for_route(uuid)`. Worker and scheduler roles also
need execution on `own_database_workspaces()`, which returns workspace ids and a connection
version derived from the encryption nonce, never a URL or ciphertext. These functions revoke
execution from `PUBLIC`.

The system scheduler also needs execution on `own_database_probes()`, which lists only
connected or unreachable own workspace ids. Health probes use the system SMTP sender;
their notices contain only the workspace name, host and transition time.

The API role also needs execution on `bot_account_available(uuid, text)` and
`claim_own_bot_account(uuid, uuid, text)`. The latter verifies the transaction's workspace
scope and commits an own-database route before the customer write. Its account lock is
shared with the hosted `bot_global_account_guard` trigger, so concurrent creates across
the two modes cannot claim the same Telegram bot. A failed customer transaction removes
only the route claimed by that request.

Each forward SQL file has a matching file in `down/`. Reverse the filename order
when reverting, executing each corresponding down file in a transaction. The
initial schema rollback removes all foreign keys before dropping the tables so
the workspace/admin-person cycle can be reversed without `CASCADE`.

`npm run test:integration -- tests/integration/platform/db/migrations.test.ts`
exercises forward, reverse and forward again against disposable PostgreSQL 15
with pgvector. Library-owned better-auth and pg-boss tables are installed by
their owners in the phases that introduce those libraries.
