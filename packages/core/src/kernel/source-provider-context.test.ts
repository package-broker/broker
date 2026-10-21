import { describe, expect, it, vi } from 'vitest';
import type { PluginDefinition, SourceProviderContext } from '../plugin.js';
import { collectRegistrations } from './registry.js';

describe('source provider factory context', () => {
  const context: SourceProviderContext = {
    runtime: 'cloudflare',
    tokensFor: async () => null,
  };

  it('passes runtime capabilities to the factory', () => {
    const sourceProviders = vi.fn(() => []);
    collectRegistrations([definition(sourceProviders)], { sourceProviderContext: context });
    expect(sourceProviders).toHaveBeenCalledExactlyOnceWith(context);
  });

  it('continues loading zero-argument plugins with runtime context', () => {
    const sourceProviders = () => [];
    const registration = collectRegistrations([definition(sourceProviders)], {
      sourceProviderContext: context,
    });
    expect(registration.bindings.get('source')).toBe('fixture');
    expect(registration.sourceProviders.size).toBe(0);
  });
});

function definition(
  sourceProviders: NonNullable<PluginDefinition['sourceProviders']>,
): PluginDefinition {
  return {
    id: 'fixture',
    package: '@test/fixture',
    apiVersion: 3,
    platforms: ['cloudflare', 'node'],
    binds: ['source'],
    sourceProviders,
  };
}
