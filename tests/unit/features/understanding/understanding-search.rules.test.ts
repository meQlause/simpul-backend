import { expect, test } from 'vitest';
import { searchRequest } from '../../../../src/features/understanding/understanding.schema.js';
import {
  searchAllowed,
  searchRange,
} from '../../../../src/features/understanding/understanding-search.rules.js';

const day = 86_400_000;
const unitAt = Date.parse('2026-10-15T02:00:00Z');

// T1 — AC4: the default is the 14 days before the unit, never more than 60, never after the unit.
test('RAG (AC4): the range defaults to 14 days before the unit and is clamped to 60 days and to the unit', () => {
  expect(searchRange(unitAt, {})).toEqual({ from: unitAt - 14 * day, to: unitAt });
  expect(searchRange(unitAt, { from: unitAt - 90 * day }).from).toBe(unitAt - 60 * day);
  expect(searchRange(unitAt, { to: unitAt + 3 * day }).to).toBe(unitAt);
  expect(searchRange(unitAt, { from: null, to: null })).toEqual({
    from: unitAt - 14 * day,
    to: unitAt,
  });
});

// T1 (AC4, the invalid day): a day that is not real never reaches the range; the schema turns it into no day.
test('RAG (AC4): a date that is not a real day is read as no date, so the default range applies', () => {
  const parsed = searchRequest.parse({
    query: 'pesanan Toko Berkah',
    from: '2026-02-30',
    to: null,
  });

  expect(parsed.from).toBeNull();
  expect(searchRange(unitAt, { from: parsed.from ? Date.parse(parsed.from) : null })).toEqual({
    from: unitAt - 14 * day,
    to: unitAt,
  });
});

// T2 — AC8: a unit is searched once; the stored query is what marks it.
test('RAG (AC8): a unit may be searched only while no query is stored', () => {
  expect(searchAllowed({ searchQuery: null })).toBe(true);
  expect(searchAllowed({ searchQuery: 'pesanan Toko Berkah' })).toBe(false);
});
