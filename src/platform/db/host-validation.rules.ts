import { BlockList, isIP } from 'node:net';

const IPV4 = 4;

type Networks = { nonpublicV4: string[]; nonpublicV6: string[]; globalV6: string };

function subnetList(cidrs: string[], family: 'ipv4' | 'ipv6') {
  const list = new BlockList();

  for (const cidr of cidrs) {
    const [address, prefix] = cidr.split('/');

    list.addSubnet(address, Number(prefix), family);
  }

  return list;
}

function addressList(addresses: string[]) {
  const list = new BlockList();

  for (const host of addresses) {
    list.addAddress(host, isIP(host) === IPV4 ? 'ipv4' : 'ipv6');
  }

  return list;
}

export function hostAllowed(address: string, systemAddresses: string[], networks: Networks) {
  const version = isIP(address);

  if (!version) {
    return false;
  }

  const family = version === IPV4 ? 'ipv4' : 'ipv6';
  const system = addressList(systemAddresses);
  const nonpublic = subnetList(
    version === IPV4 ? networks.nonpublicV4 : networks.nonpublicV6,
    family,
  );
  const globalV6 = subnetList([networks.globalV6], 'ipv6');

  return (
    !system.check(address, family) &&
    !nonpublic.check(address, family) &&
    (version === IPV4 || globalV6.check(address, 'ipv6'))
  );
}
