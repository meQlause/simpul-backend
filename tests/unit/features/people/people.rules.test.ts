import { expect, test } from 'vitest';
import { resolveRecipient } from '../../../../src/features/people/people.rules.js';

const available = (id: string) => ({ id, active: true, availability: 'available' as const });
const away = (id: string) => ({ id, active: true, availability: 'leave' as const });
const origin = 'origin-channel';

test.each([
  [
    {
      holder: available('holder'),
      backup: available('backup'),
      supervisor: available('manager'),
      admin: available('admin'),
    },
    'holder',
    'holder',
  ],
  [
    {
      holder: away('holder'),
      backup: available('backup'),
      supervisor: available('manager'),
      admin: available('admin'),
    },
    'backup',
    'backup',
  ],
  [
    {
      holder: away('holder'),
      backup: away('backup'),
      supervisor: available('manager'),
      admin: available('admin'),
    },
    'manager',
    'supervisor',
  ],
  [
    {
      holder: away('holder'),
      backup: away('backup'),
      supervisor: away('manager'),
      admin: available('admin'),
    },
    'admin',
    'admin',
  ],
  [
    {
      holder: { ...available('holder'), active: false },
      backup: available('backup'),
      supervisor: null,
      admin: available('admin'),
    },
    'backup',
    'backup',
  ],
])(
  'resolveRecipient respects availability and the ordered chain: %j',
  (candidates, personId, via) => {
    expect(resolveRecipient(candidates, origin)).toEqual({ kind: 'person', personId, via });
  },
);

test('T-11: nobody available returns to the origin channel', () => {
  expect(
    resolveRecipient(
      { holder: away('holder'), backup: null, supervisor: null, admin: away('admin') },
      origin,
    ),
  ).toEqual({ kind: 'channel', channelId: origin });
});
