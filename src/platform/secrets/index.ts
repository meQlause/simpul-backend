import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { seal, open, wrap, unwrap } from './crypto.js';

const KEY_BYTES = 32;
const MASTER_KEY_VERSION = 1;

type Purpose = 'bot_token' | 'webhook_secret' | 'mail_password' | 'database_url';

async function dataKey(tx: PoolClient, workspaceId: string, master: Buffer) {
  const result = await tx.query<{ wrapped_key: Buffer; master_key_version: number }>(
    `INSERT INTO workspace_keys (workspace_id, wrapped_key) VALUES ($1, $2)
    ON CONFLICT (workspace_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
    RETURNING wrapped_key, master_key_version`,
    [workspaceId, wrap(master, randomBytes(KEY_BYTES), workspaceId)],
  );

  if (result.rows[0].master_key_version !== MASTER_KEY_VERSION) {
    throw new Error('Unsupported master key version');
  }

  return unwrap(master, result.rows[0].wrapped_key, workspaceId);
}

export function createSecretStore(masterKey: string) {
  const master = Buffer.from(masterKey, 'base64');

  if (master.length !== KEY_BYTES) {
    throw new Error('Invalid master key');
  }

  return {
    async put(
      tx: PoolClient,
      workspaceId: string,
      input: { purpose: Purpose; value: string; id?: string },
    ) {
      const { purpose, value } = input;
      const id = input.id ?? randomUUID();
      const key = await dataKey(tx, workspaceId, master);
      const encrypted = seal(key, Buffer.from(value), `${workspaceId}:${purpose}:${id}`);

      await tx.query(
        `INSERT INTO secrets (id, workspace_id, purpose, ciphertext, nonce) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce
        WHERE secrets.workspace_id = EXCLUDED.workspace_id AND secrets.purpose = EXCLUDED.purpose`,
        [id, workspaceId, purpose, encrypted.ciphertext, encrypted.nonce],
      );

      return id;
    },
    async get(tx: PoolClient, workspaceId: string, purpose: Purpose, id: string) {
      const result = await tx.query<{ nonce: Buffer; ciphertext: Buffer }>(
        'SELECT nonce, ciphertext FROM secrets WHERE workspace_id = $1 AND purpose = $2 AND id = $3',
        [workspaceId, purpose, id],
      );

      if (!result.rows[0]) {
        throw new Error('Secret unavailable');
      }

      const wrapped = await tx.query<{ wrapped_key: Buffer }>(
        'SELECT wrapped_key FROM workspace_keys WHERE workspace_id = $1',
        [workspaceId],
      );
      const key = unwrap(master, wrapped.rows[0].wrapped_key, workspaceId);

      return open(key, result.rows[0], `${workspaceId}:${purpose}:${id}`).toString();
    },
  };
}
