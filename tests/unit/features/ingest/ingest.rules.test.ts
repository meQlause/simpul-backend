import { expect, test } from 'vitest';
import { burstGroups, redactPii } from '../../../../src/features/ingest/ingest.rules.js';

test('The 12-second debounce groups adjacent messages; a larger gap starts a new burst', () => {
  const messages = [{ serverTs: 0 }, { serverTs: 12000 }, { serverTs: 24001 }];

  expect(burstGroups(messages, 12000)).toEqual([messages.slice(0, 2), messages.slice(2)]);
  expect(burstGroups([], 12000)).toEqual([]);
});

test.each([
  ['NIK 3173010101900001', 'NIK [REDACTED]'],
  ['rekening: 12345678', 'rekening: [REDACTED]'],
  ['bank account 1234567890', 'bank account [REDACTED]'],
  ['kartu 4111-1111-1111-1111', 'kartu [REDACTED]'],
  ['4111 1111 1111 1111', '[REDACTED]'],
  ['ORD-1234567890 tambah 2 dus', 'ORD-1234567890 tambah 2 dus'],
  ['2026-10-10 pukul 11:04:19', '2026-10-10 pukul 11:04:19'],
  ['', ''],
])(
  'Redaction removes PII patterns while preserving reference ids and ordinary text: %s',
  (body, safe) => {
    expect(redactPii(body)).toBe(safe);
    expect(redactPii(safe)).toBe(safe);
  },
);
