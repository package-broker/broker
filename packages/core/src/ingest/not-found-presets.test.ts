import { describe, expect, it } from 'vitest';
import { isRegistryNotFound, NOT_FOUND_PRESETS } from './not-found-presets.js';

describe('source-specific not-found presets', () => {
  it.each([
    ['composer_repository', '{"packages":[]}'],
    ['packagist_proxy', '{"packages":[]}'],
    ['npmjs_proxy', '{"error":"Not found"}'],
  ] as const)('recognizes the %s preset', (sourceType, body) => {
    expect(NOT_FOUND_PRESETS[sourceType].length).toBeGreaterThan(0);
    expect(isRegistryNotFound(sourceType, JSON.parse(body))).toBe(true);
  });

  it.each(['composer_repository', 'packagist_proxy', 'npmjs_proxy', 'npm_registry'] as const)(
    'rejects an unrecognized JSON 404 body for %s',
    (type) => {
      expect(isRegistryNotFound(type, { message: 'not found' })).toBe(false);
    },
  );

  it.each(['composer_repository', 'packagist_proxy', 'npmjs_proxy', 'npm_registry'] as const)(
    'rejects a 404 body with extra fields for %s',
    (type) => {
      expect(isRegistryNotFound(type, { packages: [], error: 'Not found', extra: true })).toBe(
        false,
      );
    },
  );

  it('fails closed for a generic npm registry without an established 404 contract', () => {
    expect(NOT_FOUND_PRESETS.npm_registry).toEqual([]);
    expect(isRegistryNotFound('npm_registry', { error: 'Not found' })).toBe(false);
  });

  it('fails closed for a source type without a preset', () => {
    expect(isRegistryNotFound('vcs', { packages: [] })).toBe(false);
    expect(isRegistryNotFound('hosted', { error: 'Not found' })).toBe(false);
    expect(isRegistryNotFound('toString', { packages: [] })).toBe(false);
  });

  it.each(['composer_repository', 'packagist_proxy', 'npmjs_proxy', 'npm_registry'] as const)(
    'rejects a null 404 body for %s',
    (type) => {
      expect(isRegistryNotFound(type, null)).toBe(false);
    },
  );
});
