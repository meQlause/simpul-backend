import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

export function seal(key: Buffer, value: Buffer, context: string) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return { nonce, ciphertext: Buffer.concat([cipher.getAuthTag(), encrypted]) };
}

export function open(key: Buffer, sealed: { nonce: Buffer; ciphertext: Buffer }, context: string) {
  const decipher = createDecipheriv(ALGORITHM, key, sealed.nonce);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(sealed.ciphertext.subarray(0, TAG_BYTES));
  return Buffer.concat([decipher.update(sealed.ciphertext.subarray(TAG_BYTES)), decipher.final()]);
}

export function wrap(key: Buffer, dataKey: Buffer, workspaceId: string) {
  const encrypted = seal(key, dataKey, workspaceId);
  return Buffer.concat([encrypted.nonce, encrypted.ciphertext]);
}

export function unwrap(key: Buffer, wrapped: Buffer, workspaceId: string) {
  return open(
    key,
    { nonce: wrapped.subarray(0, NONCE_BYTES), ciphertext: wrapped.subarray(NONCE_BYTES) },
    workspaceId,
  );
}
