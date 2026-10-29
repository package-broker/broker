import { describe, expect, it, vi } from 'vitest';
import type { IdentityProvider } from './port.js';
import { reauthCapability } from './reauth-capability.js';

function provider(supportsReauth: boolean, resolve?: () => Promise<boolean>): IdentityProvider {
  return {
    id: 'dex',
    kind: 'oidc',
    displayName: 'Dex',
    trustAnchor: 'oidc:https://dex.example.test',
    supportsReauth,
    policy: { verifiedDomains: [], autoJoin: false },
    ...(resolve === undefined ? {} : { reauthCapability: resolve }),
    start: vi.fn(),
    finish: vi.fn(),
  };
}

describe('effective reauthentication capability', () => {
  it('coalesces concurrent resolution and caches each provider instance independently', async () => {
    const resolve = vi.fn(async () => true);
    const first = provider(false, resolve);
    const second = provider(true, async () => false);
    expect(await Promise.all([reauthCapability(first), reauthCapability(first)])).toEqual([
      true,
      true,
    ]);
    expect(await reauthCapability(first)).toBe(true);
    expect(await reauthCapability(second)).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    'falls back to static %s after failure and allows retry',
    async (fallback) => {
      const resolve = vi
        .fn<() => Promise<boolean>>()
        .mockRejectedValueOnce(new Error('discovery unavailable'))
        .mockResolvedValue(!fallback);
      const source = provider(fallback, resolve);
      expect(await reauthCapability(source)).toBe(fallback);
      expect(await reauthCapability(source)).toBe(!fallback);
      expect(await reauthCapability(source)).toBe(!fallback);
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(await reauthCapability(provider(fallback))).toBe(fallback);
    },
  );
});
