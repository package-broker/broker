import type { IdentityProvider } from './port.js';

const capabilities = new WeakMap<IdentityProvider, Promise<boolean>>();

export function reauthCapability(provider: IdentityProvider): Promise<boolean> {
  if (provider.reauthCapability === undefined) return Promise.resolve(provider.supportsReauth);
  const cached = capabilities.get(provider);
  if (cached !== undefined) return cached;
  const pending = Promise.resolve()
    .then(() => provider.reauthCapability!())
    .then(
      (resolved) => {
        if (typeof resolved === 'boolean') return resolved;
        capabilities.delete(provider);
        return provider.supportsReauth;
      },
      () => {
        capabilities.delete(provider);
        return provider.supportsReauth;
      },
    );
  capabilities.set(provider, pending);
  return pending;
}
