import { definePlugin } from '@package-broker/core/plugin';
import { describe, expect, it } from 'vitest';
import { orderPlugins, renderManifestTs, validatePlugins } from './manifest.js';

const plugin = (id: string, extra: { dependsOn?: string[]; apiVersion?: number } = {}) =>
  definePlugin({
    id,
    package: `@package-broker/plugin-${id}`,
    apiVersion: extra.apiVersion ?? 2,
    platforms: ['node'],
    ...(extra.dependsOn ? { dependsOn: extra.dependsOn } : {}),
  });

describe('manifest', () => {
  it('accepts a valid plugin set and orders by dependency', () => {
    const plugins = [plugin('b', { dependsOn: ['a'] }), plugin('a')];
    expect(validatePlugins(plugins, 'node')).toEqual([]);
    expect(orderPlugins(plugins).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('keeps config order when multiple plugins are ready', () => {
    const plugins = [plugin('b', { dependsOn: ['a'] }), plugin('c'), plugin('a')];
    expect(orderPlugins(plugins).map((p) => p.id)).toEqual(['c', 'a', 'b']);
  });

  it('throws a cycle error naming a plugin that cannot be placed', () => {
    const plugins = [
      plugin('c'),
      plugin('b', { dependsOn: ['a'] }),
      plugin('a', { dependsOn: ['b'] }),
    ];
    expect(() => orderPlugins(plugins)).toThrow('dependency cycle at plugin "b"');
  });

  it('keeps config order without dependencies', () => {
    const plugins = [plugin('c'), plugin('b'), plugin('a')];
    expect(orderPlugins(plugins)).toEqual(plugins);
  });

  it('reports duplicate ids, unsupported targets, api range and missing dependencies', () => {
    const errors = validatePlugins(
      [plugin('a'), plugin('a'), plugin('c', { apiVersion: 4, dependsOn: ['zz'] })],
      'cloudflare',
    );
    expect(errors.join('\n')).toMatch(/duplicate plugin id "a"/);
    expect(errors.join('\n')).toMatch(/does not support target "cloudflare"/);
    expect(errors.join('\n')).toMatch(/apiVersion 4/);
    expect(errors.join('\n')).toMatch(/missing plugin "zz"/);
  });

  it('renders static imports', () => {
    expect(renderManifestTs([plugin('a')])).toContain(
      "import plugin0 from '@package-broker/plugin-a';",
    );
  });
});
