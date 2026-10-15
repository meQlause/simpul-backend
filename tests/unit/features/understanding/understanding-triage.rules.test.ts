import { expect, test } from 'vitest';
import { readTriage } from '../../../../src/features/understanding/understanding-triage.rules.js';

// T1 — AC1: the JSON answer keeps both fields.
test('T1: a JSON answer gives the class and the referenced day', () => {
  expect(readTriage('{"class":"EVENT","referencedDate":"2026-10-14"}')).toEqual({
    triageClass: 'EVENT',
    referencedDate: '2026-10-14',
  });
});

// T2 — AC2: a plain word still works; a date that is not a real day is dropped, not an error.
test('T2: plain words and invalid dates keep the class and drop the date', () => {
  expect(readTriage('EVENT')).toEqual({ triageClass: 'EVENT', referencedDate: null });
  expect(readTriage(' NOISE\n')).toEqual({ triageClass: 'NOISE', referencedDate: null });
  expect(readTriage('{"class":"QUERY","referencedDate":null}')).toEqual({
    triageClass: 'QUERY',
    referencedDate: null,
  });
  expect(readTriage('{"class":"EVENT","referencedDate":"2026-02-30"}')).toEqual({
    triageClass: 'EVENT',
    referencedDate: null,
  });
  expect(readTriage('{"class":"EVENT","referencedDate":"14 Okt"}')).toEqual({
    triageClass: 'EVENT',
    referencedDate: null,
  });

  expect(() => readTriage('MAYBE')).toThrow();
  expect(() => readTriage('{"class":"MAYBE"}')).toThrow();
});
