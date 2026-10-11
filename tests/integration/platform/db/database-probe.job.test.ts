import postgres from 'pg';
import type { PgBoss } from 'pg-boss';
import { beforeAll, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import addresses from '../../../fixtures/host-addresses.json' with { type: 'json' };
import { createSecretStore } from '../../../../src/platform/secrets/index.js';
import { scopedTransaction } from '../../../../src/platform/db/scoped-transaction.js';
import { provisionAdmin } from '../../../../src/features/auth/index.js';
import { registerSchedulerJobs } from '../../../../src/roles/scheduler.js';

const system = databaseFixture(3);
const customer = databaseFixture(2, { tls: true, restartable: true });
const workspaceId = '00000000-0000-4000-8000-000000100001';
const secretStore = createSecretStore(Buffer.alloc(32, 5).toString('base64'));
const sendMail = vi.fn(async (_message: unknown) => {});
let now = new Date('2026-10-11T10:00:00Z');
const callbacks = new Map<string, () => Promise<void>>();
const queue = {
  schedule: vi.fn(),
  work: vi.fn(async (name: string, callback: () => Promise<void>) => {
    callbacks.set(name, callback);
  }),
};
const services = {
  systemPool: system,
  secretStore,
  sendMail,
  now: () => now,
  systemHost: 'system.example',
  lookup: async (host: string) => [
    {
      address: host === 'system.example' ? addresses.systemAddress : addresses.publicAddress,
      family: 4,
    },
  ],
  openPool: (config: postgres.PoolConfig) => {
    const target = new URL(customer.options.connectionString!);

    return new postgres.Pool({
      ...config,
      host: target.hostname,
      port: Number(target.port),
      ssl: { ...(config.ssl as object), ca: customer.certificate() },
    });
  },
};

beforeAll(async () => {
  await applyMigrations(system);
  await scopedTransaction(
    async () => system,
    workspaceId,
    async (tx) => {
      await provisionAdmin(tx, {
        id: 'probe-admin',
        email: 'probe@example.test',
        name: 'Admin',
        token: 'probe-reset',
        expiresAt: new Date('2099-01-01'),
        now,
      });
      const ref = await secretStore.put(tx, workspaceId, {
        purpose: 'database_url',
        value: 'postgres://postgres:probe-password@customer.example/postgres?sslmode=require',
      });

      await tx.query(
        `INSERT INTO workspace_databases (workspace_id, workspace_name, timezone, admin_auth_user_id,
      status, url_secret_ref, host, availability_ack_at, connected_at) VALUES ($1, 'Probe workspace', 'Asia/Jakarta',
      'probe-admin', 'connected', $2, 'customer.example', $3, $3)`,
        [workspaceId, ref, now],
      );
    },
  );
  customer.on('error', () => {});
}, 120000);

async function probeAt(
  time: string,
  expected: { status: string; probe_streak: number; unreachable_since: Date | null },
  emails: number,
) {
  now = new Date(time);
  await callbacks.get('database.probe')!();
  expect(
    (await system.query('SELECT status, probe_streak, unreachable_since FROM workspace_databases'))
      .rows,
  ).toEqual([expected]);
  expect(sendMail).toHaveBeenCalledTimes(emails);
}

async function failedProbes() {
  customer.stopDatabase();
  await probeAt(
    '2026-10-11T10:00:00Z',
    { status: 'connected', probe_streak: 1, unreachable_since: null },
    0,
  );
  customer.startDatabase();
  await probeAt(
    '2026-10-11T10:01:00Z',
    { status: 'connected', probe_streak: 0, unreachable_since: null },
    0,
  );
  customer.stopDatabase();
  await probeAt(
    '2026-10-11T10:02:00Z',
    { status: 'connected', probe_streak: 1, unreachable_since: null },
    0,
  );
  const outage = new Date('2026-10-11T10:03:00Z');

  await probeAt(
    '2026-10-11T10:03:00Z',
    { status: 'unreachable', probe_streak: 0, unreachable_since: outage },
    1,
  );
  await probeAt(
    '2026-10-11T10:04:00Z',
    { status: 'unreachable', probe_streak: 0, unreachable_since: outage },
    1,
  );
  customer.startDatabase();
  await probeAt(
    '2026-10-11T10:05:00Z',
    { status: 'unreachable', probe_streak: 1, unreachable_since: outage },
    1,
  );
}

test('NFR-DB-05: two failed probes send one outage email, two successful probes send one recovery email, and one failure changes no status', async () => {
  await registerSchedulerJobs(queue as unknown as PgBoss, system, services);
  expect(callbacks.get('database.probe')).toBeTypeOf('function');
  expect(queue.schedule).toHaveBeenCalledWith('database.probe', '* * * * *');
  await failedProbes();
  await probeAt(
    '2026-10-11T10:06:00Z',
    { status: 'connected', probe_streak: 0, unreachable_since: null },
    2,
  );
  await probeAt(
    '2026-10-11T10:07:00Z',
    { status: 'connected', probe_streak: 0, unreachable_since: null },
    2,
  );
  expect(sendMail.mock.calls.map(([message]) => message)).toMatchObject([
    {
      to: 'probe@example.test',
      subject: 'Simpul cannot reach your database',
      text: 'Simpul has not been able to reach the database for Probe workspace at customer.example since 2026-10-11T10:03:00.000Z. New messages are not being recorded until it is back. Messages older than 24 hours when it returns are lost.',
    },
    {
      to: 'probe@example.test',
      subject: 'Simpul can reach your database again',
      text: 'The database for Probe workspace at customer.example is reachable again as of 2026-10-11T10:06:00.000Z. Messages are being recorded.',
    },
  ]);
  expect(JSON.stringify(sendMail.mock.calls)).not.toContain('probe-password');
}, 30000);
