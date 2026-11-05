import { definePlugin } from '@package-broker/core/plugin';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import {
  snapshotLocalAuthCapability,
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
  it.each([
    ['same', 'same'],
    ['bad/id', 'good'],
  ])('refuses ambiguous scanner ids: %s', (first, second) => {
    const scanners = [first, second].map((id, index) => ({
      ...plugin(index ? 'b' : 'a'),
      publishPolicy: { id, inspect: async () => ({ verdict: 'allow' as const }) },
    }));
    expect(validatePlugins(scanners, 'node')).toContain(
      'publishPolicy ids must be valid and unique',
    );
  });

  it('refuses more than three publish scanners as a fixed configuration problem', () => {
    const scanners = ['a', 'b', 'c', 'd'].map((id) => ({
      ...plugin(id),
      publishPolicy: { id, inspect: async () => ({ verdict: 'allow' as const }) },
    }));
    expect(validatePlugins(scanners.slice(0, 3), 'node')).toEqual([]);
    expect(validatePlugins(scanners, 'node')).toContain(
      'at most three publishPolicy plugins are supported',
    );
  });
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

it.each([
  { verifiedDomains: ['example.com'] },
  { verifiedDomains: ['example.com'], emailAuthoritativeDomains: [] },
  { verifiedDomains: ['example.com'], emailAuthoritativeDomains: ['example.com'] },
])('preserves declared domain policy in JSON with independent copies: %j', (policy) => {
  const identityPlugin = definePlugin({
    id: 'identity-fixture',
    package: '@example/identity',
    apiVersion: 3,
    platforms: ['node'],
    binds: ['identity'],
    identityProviders: () => [],
    identityDescriptor: {
      runtimeProviders: true,
      compiled: [{ id: 'corp', kind: 'oidc', anchor: 'oidc:https://idp.example.com', policy }],
    },
  });
  const expected = JSON.parse(JSON.stringify(policy)) as unknown;
  const registration = collectRegistrations([identityPlugin]);
  policy.verifiedDomains.push('changed.example.com');
  policy.emailAuthoritativeDomains?.push('changed.example.com');
  const manifest = renderManifestJson([identityPlugin], new Map(), 'node', { registration });
  const emitted = manifest.identity!.compiled[0]!.policy!;
  expect(JSON.parse(JSON.stringify(manifest)).identity.compiled[0].policy).toEqual(expected);
  const snapshot = registration.identityDescriptor!.compiled[0]!.policy!;
  expect(emitted).not.toBe(snapshot);
  expect(emitted.verifiedDomains).not.toBe(snapshot.verifiedDomains);
  if (emitted.emailAuthoritativeDomains !== undefined) {
    expect(emitted.emailAuthoritativeDomains).not.toBe(snapshot.emailAuthoritativeDomains);
  }
  (emitted.verifiedDomains as string[]).push('output.example.com');
  (emitted.emailAuthoritativeDomains as string[] | undefined)?.push('output.example.com');
  expect(snapshot).toEqual(expected);
});

describe('local-auth artifact capability', () => {
  it.each(['node', 'cloudflare'] as const)('uses the bundled %s runtime marker', (platform) => {
    for (const version of ['2.0.0-rc.2', '2.0.0-rc.3', '2.0.0-rc.4', '3.0.0']) {
      const runtimeMetadata = { version, packageBroker: { localAuth: 1 } };
      const manifest = renderManifestJson([], new Map(), platform, { runtimeMetadata });
      expect(JSON.parse(JSON.stringify(manifest)).localAuth).toEqual({ version: 1 });
    }
  });

  it.each([
    undefined,
    null,
    [],
    'private-input',
    { version: '2.0.0-rc.3' },
    { version: '2.0.0-rc.4' },
    { version: '2.1.0' },
    { packageBroker: null },
    { packageBroker: [] },
    { packageBroker: 1 },
    { packageBroker: {} },
    { packageBroker: { localAuth: '1' } },
    { packageBroker: { localAuth: true } },
    { packageBroker: { localAuth: 0 } },
    { packageBroker: { localAuth: 2 } },
  ])('omits unproven runtime support: %j', (runtimeMetadata) => {
    expect(renderManifestJson([], new Map(), 'cloudflare', { runtimeMetadata })).not.toHaveProperty(
      'localAuth',
    );
  });

  it('copies and freezes the supported capability', () => {
    const source = { version: 1 };
    const snapshot = snapshotLocalAuthCapability(source);
    source.version = 2;
    expect(snapshot).toEqual({ version: 1 });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it.each([
    undefined,
    null,
    [],
    true,
    'private-input',
    {},
    { version: '1' },
    { version: 2 },
    { version: 1, extra: true },
  ])('refuses malformed or unknown capability %j', (value) => {
    expect(snapshotLocalAuthCapability(value)).toBeNull();
  });
});
