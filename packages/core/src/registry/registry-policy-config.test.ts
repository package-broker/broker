import { describe, expect, it } from 'vitest';
import { DEFAULT_HOOK_TIMEOUT_MS } from '../kernel/access.js';
import {
  REGISTRY_DEFAULTS,
  RegistryConfigError,
  resolveRegistryConfig,
  validateRegistryConfig,
} from './registry-config.js';

const PUBLIC_URL = 'https://broker.example.com';

describe('registry.policy', () => {
  it.each(['cloudflare', 'node'] as const)('is off with a 1000 ms hook budget on %s', (target) => {
    expect(resolveRegistryConfig(undefined, target, PUBLIC_URL).policy).toEqual({
      enabled: false,
      hookBudgetMs: 1000,
    });
    expect(resolveRegistryConfig({}, target, PUBLIC_URL).policy.enabled).toBe(false);
    expect(resolveRegistryConfig({ policy: {} }, target, PUBLIC_URL).policy).toEqual({
      enabled: false,
      hookBudgetMs: 1000,
    });
    expect(REGISTRY_DEFAULTS.policy).toEqual({ enabled: false, hookBudgetMs: 1000 });
    expect(Object.isFrozen(REGISTRY_DEFAULTS.policy)).toBe(true);
  });

  it('defaults the hook budget to the access hook deadline', () => {
    expect(REGISTRY_DEFAULTS.policy.hookBudgetMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(resolveRegistryConfig(undefined, 'node', PUBLIC_URL).policy.hookBudgetMs).toBe(
      DEFAULT_HOOK_TIMEOUT_MS,
    );
  });

  it.each(['cloudflare', 'node'] as const)('turns on and takes a custom budget on %s', (target) => {
    const input = { policy: { enabled: true, hookBudgetMs: 250 } };
    expect(validateRegistryConfig(input, target)).toEqual([]);
    expect(resolveRegistryConfig(input, target, PUBLIC_URL).policy).toEqual({
      enabled: true,
      hookBudgetMs: 250,
    });
    expect(resolveRegistryConfig({ policy: { enabled: true } }, target, PUBLIC_URL).policy).toEqual(
      { enabled: true, hookBudgetMs: 1000 },
    );
  });

  it('accepts the budget bounds and refuses bound+1', () => {
    expect(validateRegistryConfig({ policy: { hookBudgetMs: 1 } }, 'node')).toEqual([]);
    expect(validateRegistryConfig({ policy: { hookBudgetMs: 600_000 } }, 'node')).toEqual([]);
    expect(validateRegistryConfig({ policy: { hookBudgetMs: 600_001 } }, 'node')).toEqual([
      'registry.policy.hookBudgetMs: exceeds the maximum',
    ]);
  });

  it.each([0, -1, 1.5, '1000', null, Number.NaN, 2 ** 53])(
    'refuses hookBudgetMs=%j with a fixed message',
    (value) => {
      expect(validateRegistryConfig({ policy: { hookBudgetMs: value } }, 'node')).toEqual([
        'registry.policy.hookBudgetMs: must be a positive integer',
      ]);
      expect(() =>
        resolveRegistryConfig({ policy: { hookBudgetMs: value } } as never, 'node', PUBLIC_URL),
      ).toThrow(RegistryConfigError);
    },
  );

  it.each(['yes', 1, null])('refuses enabled=%j', (value) => {
    expect(validateRegistryConfig({ policy: { enabled: value } }, 'cloudflare')).toEqual([
      'registry.policy.enabled: must be a boolean',
    ]);
  });

  it('refuses an unknown key and a non-object section without echoing the key', () => {
    expect(validateRegistryConfig({ policy: { failOpen: true } }, 'node')).toEqual([
      'registry.policy.failOpen: unknown key',
    ]);
    expect(
      validateRegistryConfig({ policy: { ghp_abcdefghijklmnopqrstuvwxyz0123456789: 1 } }, 'node'),
    ).toEqual(['registry.policy.<redacted>: unknown key']);
    expect(validateRegistryConfig({ policy: true }, 'node')).toEqual([
      'registry.policy: must be an object',
    ]);
  });
});
