import { expect, test } from 'vitest';
import { seal, open, wrap, unwrap } from '../../../../src/platform/secrets/crypto.js';

const key = Buffer.alloc(32, 1);
const value = Buffer.from('test-only-password');
const context = 'workspace:purpose:id';

test('authenticated encryption round-trips without exposing plaintext', () => {
  const encrypted = seal(key, value, context);
  expect(encrypted.ciphertext.includes(value)).toBe(false);
  expect(open(key, encrypted, context)).toEqual(value);
  expect(seal(key, value, context).nonce).not.toEqual(encrypted.nonce);
});

test('a database copy cannot decrypt with a different master or data key', () => {
  expect(() => open(Buffer.alloc(32, 2), seal(key, value, context), context)).toThrow();
});

test('ciphertext cannot be moved to another workspace, purpose or secret id', () => {
  expect(() => open(key, seal(key, value, context), 'other-workspace:purpose:id')).toThrow();
});

test('tampered ciphertext fails authentication', () => {
  const encrypted = seal(key, value, context);
  encrypted.ciphertext[0] ^= 1;
  expect(() => open(key, encrypted, context)).toThrow();
});

test('a workspace data key is wrapped under the master key and bound to that workspace', () => {
  const dataKey = Buffer.alloc(32, 3);
  const wrapped = wrap(key, dataKey, 'workspace');
  expect(unwrap(key, wrapped, 'workspace')).toEqual(dataKey);
  expect(() => unwrap(Buffer.alloc(32, 2), wrapped, 'workspace')).toThrow();
  expect(() => unwrap(key, wrapped, 'other-workspace')).toThrow();
});
