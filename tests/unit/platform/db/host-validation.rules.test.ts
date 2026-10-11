import { expect, test } from 'vitest';
import { hostAllowed } from '../../../../src/platform/db/host-validation.rules.js';
import networks from '../../../../src/platform/db/host-networks.json' with { type: 'json' };
import addresses from '../../../fixtures/host-addresses.json' with { type: 'json' };

test.each(addresses.refused)(
  'hostAllowed refuses nonpublic or metadata address %s (NFR-DB-04)',
  (address) => {
    expect(hostAllowed(address, [addresses.systemAddress], networks)).toBe(false);
  },
);

test.each(addresses.allowed)('hostAllowed accepts public address %s (NFR-DB-04)', (address) => {
  expect(hostAllowed(address, [addresses.systemAddress], networks)).toBe(true);
});

test('hostAllowed refuses the system database address, including equivalent IPv6 forms (NFR-DB-04)', () => {
  expect(hostAllowed(addresses.systemAddress, [addresses.systemAddress], networks)).toBe(false);
  expect(hostAllowed(addresses.expandedSystemV6, [addresses.systemV6], networks)).toBe(false);
});
