import { definePlugin } from '@package-broker/core/plugin';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import {
  orderPlugins,
  renderManifestJson,
  renderManifestTs,
  validatePlugins,
  type Manifest,
} from './manifest.js';

const plugin = (id: string, extra: { dependsOn?: string[]; apiVersion?: number } = {}) =>
  definePlugin({
    id,
    package: `@package-broker/plugin-${id}`,
    apiVersion: extra.apiVersion ?? 3,
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
      [plugin('a'), plugin('a'), plugin('c', { apiVersion: 5, dependsOn: ['zz'] })],
      'cloudflare',
    );
    expect(errors.join('\n')).toMatch(/duplicate plugin id "a"/);
    expect(errors.join('\n')).toMatch(/does not support target "cloudflare"/);
    expect(errors.join('\n')).toMatch(/apiVersion 5/);
    expect(errors.join('\n')).toMatch(/missing plugin "zz"/);
  });

  it('reports an API 2 plugin with the range message and accepts API 3', () => {
    expect(validatePlugins([plugin('legacy', { apiVersion: 2 })], 'node')).toEqual([
      'plugin "legacy" has apiVersion 2, core supports 3 to 4',
    ]);
    expect(validatePlugins([plugin('current', { apiVersion: 3 })], 'node')).toEqual([]);
  });

  it('renders static imports', () => {
    expect(renderManifestTs([plugin('a')])).toContain(
      "import plugin0 from '@package-broker/plugin-a';",
    );
  });
});

it('types the optional build manifest platform ports description', () => {
  expectTypeOf<Manifest['platformPorts']>().toEqualTypeOf<PlatformPortConfig | null | undefined>();
});

describe('manifest routes', () => {
  const routed = definePlugin({
    id: 'widgets',
    package: '@package-broker/plugin-widgets',
    apiVersion: 3,
    platforms: ['node'],
    register: (registrar) => {
      registrar.route({
        method: 'GET',
        path: '/widgets',
        permission: 'org:read',
        boundary: 'organization',
        handler: () => new Response(null),
      });
      registrar.route({
        method: 'GET',
        path: '/ping',
        permission: null,
        needsOrg: false,
        handler: () => new Response(null),
      });
    },
  });

  it('carries boundary and needsOrg in a fixed key order and omits what is undeclared', () => {
    const registration = collectRegistrations([routed]);
    const manifest = renderManifestJson([routed], new Map(), 'node', { registration });
    expect(manifest.routes.map((route) => Object.keys(route))).toEqual([
      ['method', 'path', 'plugin', 'permission', 'boundary'],
      ['method', 'path', 'plugin', 'permission', 'boundary', 'needsOrg'],
    ]);
    expect(manifest.routes[0]?.boundary).toBe('organization');
    expect(manifest.routes[1]?.needsOrg).toBe(false);
  });
});

it('serializes declared and absent route boundaries explicitly', () => {
  const routed = definePlugin({
    id: 'boundary-fixture',
    package: '@package-broker/plugin-boundary-fixture',
    apiVersion: 3,
    platforms: ['node'],
    register: (registrar) => {
      registrar.route({
        method: 'GET',
        path: '/org',
        permission: 'org:read',
        boundary: 'organization',
        handler: () => new Response(null),
      });
      registrar.route({
        method: 'GET',
        path: '/public',
        permission: null,
        handler: () => new Response(null),
      });
    },
  });
  const manifest = renderManifestJson([routed], new Map(), 'node', {
    registration: collectRegistrations([routed]),
  });
  expect(
    JSON.parse(JSON.stringify(manifest)).routes.map(
      (route: { boundary: unknown }) => route.boundary,
    ),
  ).toEqual(['organization', null]);
});

it('copies identity metadata from the registration snapshot without rereading the plugin', () => {
  const descriptor = {
    runtimeProviders: true,
    compiled: [{ id: 'corp', kind: 'oidc' as const, anchor: 'oidc:https://idp.example.com' }],
  };
  const identityPlugin = definePlugin({
    id: 'identity-fixture',
    package: '@example/identity',
    apiVersion: 3,
    platforms: ['node'],
    binds: ['identity'],
    identityProviders: () => [],
    identityDescriptor: descriptor,
  });
  const registration = collectRegistrations([identityPlugin]);
  descriptor.runtimeProviders = false;
  descriptor.compiled[0]!.anchor = 'oidc:https://other.example.com';
  const manifest = renderManifestJson([identityPlugin], new Map(), 'node', { registration });
  expect(manifest.identity).toEqual({
    runtimeProviders: true,
    compiled: [{ id: 'corp', kind: 'oidc', anchor: 'oidc:https://idp.example.com' }],
  });
  expect(manifest.identity).not.toBe(registration.identityDescriptor);
  expect(manifest.identity?.compiled[0]).not.toBe(registration.identityDescriptor?.compiled[0]);
  expect(renderManifestJson([identityPlugin], new Map(), 'node')).not.toHaveProperty('identity');
});
