import { definePlugin } from '@package-broker/core/plugin';
import { describe, expect, it } from 'vitest';
import { orderPlugins, renderManifestTs, validatePlugins } from './manifest.js';

const plugin = (id: string, extra: { dependsOn?: string[]; apiVersion?: number } = {}) =>
  definePlugin({
    id,
    package: `@package-broker/plugin-${id}`,
    apiVersion: extra.apiVersion ?? 1,
    platforms: ['node'],
    ...(extra.dependsOn ? { dependsOn: extra.dependsOn } : {}),
  });

describe('manifest', () => {
  it('accepts a valid plugin set and orders by dependency', () => {
    const plugins = [plugin('b', { dependsOn: ['a'] }), plugin('a')];
    expect(validatePlugins(plugins, 'node')).toEqual([]);
    expect(orderPlugins(plugins).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('reports duplicate ids, unsupported targets, api range and missing dependencies', () => {
    const errors = validatePlugins(
      [plugin('a'), plugin('a'), plugin('c', { apiVersion: 2, dependsOn: ['zz'] })],
      'cloudflare',
    );
    expect(errors.join('\n')).toMatch(/duplicate plugin id "a"/);
    expect(errors.join('\n')).toMatch(/does not support target "cloudflare"/);
    expect(errors.join('\n')).toMatch(/apiVersion 2/);
    expect(errors.join('\n')).toMatch(/missing plugin "zz"/);
  });

  it('renders static imports', () => {
    expect(renderManifestTs([plugin('a')])).toContain(
      "import plugin0 from '@package-broker/plugin-a';",
    );
  });
});
