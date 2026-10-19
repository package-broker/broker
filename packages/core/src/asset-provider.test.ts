import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  assetDeclarationProblems,
  assetProviderProblems,
  assetProviderResultProblems,
  defineAssets,
  type AssetProviderV1,
} from './config.js';
import type { PluginDefinition } from './plugin.js';

describe('asset declarations', () => {
  it('returns inert data with no plugin contract', () => {
    const input = { kind: 'ui', provider: '@package-broker/ui-assets' } as const;
    const declaration = defineAssets(input);
    expect(declaration).toBe(input);
    expect(JSON.parse(JSON.stringify(declaration))).toEqual(input);
    expectTypeOf(declaration).not.toExtend<PluginDefinition>();
    expectTypeOf(declaration.kind).toEqualTypeOf<'ui'>();
    expect(declaration).not.toHaveProperty('register');
    expect(declaration).not.toHaveProperty('init');
  });

  it.each(['@package-broker/ui-assets', 'custom-assets', 'custom-assets/provider'])(
    'accepts package specifier %s without resolving it',
    (provider) => {
      expect(assetDeclarationProblems(defineAssets({ kind: 'ui', provider }))).toEqual([]);
    },
  );

  it.each([
    undefined,
    null,
    [],
    'secret',
    1,
    {},
    { kind: 'ui' },
    { kind: 'other', provider: 'secret' },
    { kind: 'ui', provider: () => 'secret' },
    { kind: 'ui', provider: 'secret', register: () => {} },
    ...[
      '',
      ' secret ',
      './secret',
      '/secret',
      'file:///secret',
      'https://secret',
      'pkg/../secret',
    ].map((provider) => ({ kind: 'ui', provider })),
  ])('rejects invalid declarations without echoing input (%#)', (value) => {
    const problems = assetDeclarationProblems(value);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join()).not.toContain('secret');
  });
});

describe('asset provider port', () => {
  it.each(['node', 'cloudflare'] as const)('supports the build target %s', async (target) => {
    const provider: AssetProviderV1 = {
      apiVersion: 1,
      resolve: async (context) => ({
        manifestUrl: `file:///assets/${context.target}/manifest.json`,
      }),
    };
    expect(assetProviderProblems(provider)).toEqual([]);
    const result = await provider.resolve({ target });
    expect(result.manifestUrl).toBe(`file:///assets/${target}/manifest.json`);
    expect(assetProviderResultProblems(result)).toEqual([]);
  });

  it.each([undefined, 0, 2, '1', 'secret'])(
    'rejects unsupported provider apiVersion (%#)',
    (apiVersion) => {
      expect(assetProviderProblems({ apiVersion, resolve: async () => ({}) })).toEqual([
        'assets: unsupported provider apiVersion',
      ]);
    },
  );

  it.each([null, [], 'secret', {}, { apiVersion: 1 }, { apiVersion: 1, resolve: 'secret' }])(
    'rejects malformed provider objects (%#)',
    (value) => {
      const problems = assetProviderProblems(value);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join()).not.toContain('secret');
    },
  );

  it.each([
    null,
    {},
    { manifestUrl: 7 },
    ...[
      'secret',
      '/secret/manifest.json',
      'https://secret/manifest.json',
      'file://secret/share/manifest.json',
      'file:///secret/',
      'file:///secret/manifest.json?token=secret',
      'file:///secret/manifest.json#secret',
    ].map((manifestUrl) => ({ manifestUrl })),
  ])('rejects invalid manifest locations without echoing input (%#)', (value) => {
    const problems = assetProviderResultProblems(value);
    expect(problems).toEqual(['assets: provider manifestUrl must be a local file URL']);
    expect(problems.join()).not.toContain('secret');
  });
});
