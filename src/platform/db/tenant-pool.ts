import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Pool, type PoolConfig } from 'pg';
import { hostAllowed } from './host-validation.rules.js';
import networks from './host-networks.json' with { type: 'json' };
import { DomainError } from '../errors/domain-error.js';

type Address = { address: string; family: number };

export type TenantPoolOptions = {
  systemHost: string;
  lookup?: (host: string) => Promise<Address[]>;
  openPool?: (config: PoolConfig) => Pool;
};

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_PORT = 5432;
const CONNECTION_FAILED = 'E-DB-CONNECTION-FAILED';

async function resolveAddresses(host: string, options: TenantPoolOptions, timeout: number) {
  const lookup = options.lookup ?? ((name) => dnsLookup(name, { all: true, verbatim: true }));
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      lookup(host),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DomainError(CONNECTION_FAILED)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function poolConfig(url: URL, address: string, timeout: number): PoolConfig {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');

  return {
    host: address,
    port: Number(url.port || DEFAULT_PORT),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true, ...(!isIP(hostname) && { servername: hostname }) },
    max: 5,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: timeout,
    statement_timeout: timeout,
    query_timeout: timeout,
  };
}

export async function openTenantPool(
  connectionString: string,
  options: TenantPoolOptions,
  timeout = DEFAULT_TIMEOUT,
) {
  const url = new URL(connectionString);
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();

  if (
    hostname === options.systemHost.toLowerCase() ||
    url.searchParams.get('sslmode') === 'disable'
  ) {
    throw new DomainError(CONNECTION_FAILED);
  }

  const [addresses, systemAddresses] = await Promise.all([
    resolveAddresses(hostname, options, timeout),
    resolveAddresses(options.systemHost, options, timeout),
  ]);

  if (
    !addresses.length ||
    !addresses.every(({ address }) =>
      hostAllowed(
        address,
        systemAddresses.map((item) => item.address),
        networks,
      ),
    )
  ) {
    throw new DomainError(CONNECTION_FAILED);
  }

  const config = poolConfig(url, addresses[0].address, timeout);
  const pool = options.openPool ? options.openPool(config) : new Pool(config);

  pool.on?.('error', () => {});

  return pool;
}
