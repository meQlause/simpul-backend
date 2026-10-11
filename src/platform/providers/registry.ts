import type { ProviderAdapter } from './contract.js';

class UnregisteredProviderError extends Error {
  constructor(provider: string) {
    super(`No registered adapter for provider "${provider}"`);
    this.name = 'UnregisteredProviderError';
  }
}

export function createProviderRegistry() {
  const adapters = new Map<string, ProviderAdapter>();

  function adapterFor(provider: string) {
    const adapter = adapters.get(provider);

    if (!adapter) {
      throw new UnregisteredProviderError(provider);
    }

    return adapter;
  }

  return {
    register(adapter: ProviderAdapter) {
      adapters.set(adapter.provider, adapter);
    },
    adapterFor,
    assertCovers(providersInUse: readonly string[]) {
      for (const provider of providersInUse) {
        adapterFor(provider);
      }
    },
  };
}
