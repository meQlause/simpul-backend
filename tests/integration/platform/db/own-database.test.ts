import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { beforeAll, expect, test, vi } from 'vitest';
import { databaseFixture } from '../../../helpers/database.js';
import { applyMigrations } from '../../../helpers/migrations.js';
import { createSecretStore } from '../../../../src/platform/secrets/index.js';
import { createConnectionResolver } from '../../../../src/platform/db/connection-resolver.js';
import addresses from '../../../fixtures/host-addresses.json' with { type: 'json' };

const systemPool = databaseFixture();
const workspaceId = randomUUID();
const secretStore = createSecretStore(Buffer.alloc(32, 9).toString('base64'));

beforeAll(async () => {
  await applyMigrations(systemPool);
  const tx = await systemPool.connect();

  try {
    const ref = await secretStore.put(tx, workspaceId, {
      purpose: 'database_url',
      value: 'postgres://admin:secret@customer.example/simpul?sslmode=require',
    });

    await tx.query(
      `INSERT INTO workspace_databases
      (workspace_id, workspace_name, timezone, admin_auth_user_id, status, url_secret_ref, availability_ack_at)
      VALUES ($1, 'Own', 'Asia/Jakarta', 'admin', 'connected', $2, now())`,
      [workspaceId, ref],
    );
  } finally {
    tx.release();
  }
}, 120000);

test('The resolver validates DNS on each new pool and rejects a host repointed to an internal address (NFR-DB-04)', async () => {
  let address = addresses.publicAddress;
  const lookup = vi.fn(async (host: string) => [
    { address: host === 'system.example' ? addresses.systemAddress : address, family: 4 },
  ]);
  const target = {
    query: vi.fn(async () => ({ rows: [{ id: workspaceId }] })),
    end: vi.fn(async () => {}),
  } as unknown as Pool;
  const openPool = vi.fn(() => target);
  const resolve = createConnectionResolver(systemPool, {
    systemHost: 'system.example',
    secretStore,
    lookup,
    openPool,
  });

  expect(await resolve(workspaceId)).toBe(target);
  expect(openPool).toHaveBeenCalledWith(
    expect.objectContaining({
      host: addresses.publicAddress,
      max: 5,
      ssl: { rejectUnauthorized: true, servername: 'customer.example' },
    }),
  );
  await resolve.close(workspaceId);
  address = '127.0.0.1';
  await expect(resolve(workspaceId)).rejects.toMatchObject({ code: 'E-DB-UNAVAILABLE' });
  expect(openPool).toHaveBeenCalledTimes(1);
  expect(lookup.mock.calls.filter(([host]) => host === 'customer.example')).toHaveLength(2);
});

test('The resolver rejects a mixed public/private DNS answer and the system host (NFR-DB-04)', async () => {
  const openPool = vi.fn();
  const resolve = createConnectionResolver(systemPool, {
    systemHost: 'system.example',
    secretStore,
    lookup: async () => [
      { address: addresses.publicAddress, family: 4 },
      { address: addresses.privateAddress, family: 4 },
    ],
    openPool,
  });

  await expect(resolve(workspaceId)).rejects.toMatchObject({ code: 'E-DB-UNAVAILABLE' });
  expect(openPool).not.toHaveBeenCalled();
});
