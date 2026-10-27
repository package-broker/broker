import { fixedClock } from '@package-broker/core/ids';
import type { IdentityContext } from '@package-broker/core/identity/port';
import { buildIdentityProviders } from '@package-broker/core/identity/providers';
import { collectRegistrations, KernelConfigError } from '@package-broker/core/kernel/registry';
import { definePlugin, type PluginDefinition } from '@package-broker/core/plugin';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as accessModule from './cloudflare-access.js';
import ssoOidc from './index.js';
import * as oidcModule from './oidc.js';
import { RUNTIME_PROVIDERS_VARIABLE } from './runtime.js';

const oidc = {
  id: 'corp-oidc',
  kind: 'oidc',
  issuer: 'https://idp.example.com',
  clientId: 'broker-client',
  policy: { verifiedDomains: ['example.com'], autoJoin: false },
} as const;
const access = {
  id: 'corp-access',
  kind: 'cloudflare-access',
  teamDomain: 'acme.cloudflareaccess.com',
  audience: 'a'.repeat(64),
  policy: { verifiedDomains: ['example.com'], autoJoin: false },
  trustEmailVerification: true,
} as const;

function context(env: IdentityContext['env']): IdentityContext {
  return {
    fetch: () => Promise.resolve(new Response(null)),
    clock: fixedClock('2026-10-15T00:00:00.000Z'),
    env,
  };
}

function build(plugins: readonly PluginDefinition[], env: IdentityContext['env']) {
  return buildIdentityProviders(collectRegistrations(plugins), plugins, context(env));
}

function fromRaw(plugin: PluginDefinition, raw?: string) {
  const env = vi.fn((name: string) => (name === RUNTIME_PROVIDERS_VARIABLE ? raw : undefined));
  return { providers: build([plugin], env), env };
}

function diagnostics() {
  const calls = vi.mocked(console.warn).mock.calls;
  for (const call of calls) {
    expect(call).toHaveLength(1);
    expect(typeof call[0]).toBe('string');
    expect(call[0]).not.toContain('\n');
  }
  return calls.map(([line]) => JSON.parse(line as string) as Record<string, unknown>);
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('runtime identity factory through the kernel', () => {
  it('keeps the default composition unbound with an empty map', () => {
    const plugin = ssoOidc();
    expect(collectRegistrations([plugin]).bindings.has('identity')).toBe(false);
    const { providers, env } = fromRaw(plugin, JSON.stringify([oidc]));
    expect(providers.size).toBe(0);
    expect(env).not.toHaveBeenCalled();
  });

  it('allows another identity plugin alongside default ssoOidc()', () => {
    const other = definePlugin({
      id: 'other-identity',
      package: '@test/other-identity',
      apiVersion: 3,
      platforms: ['node'],
      binds: ['identity'],
      identityProviders: (ctx) => [oidcModule.createOidcProvider(oidc, ctx)],
    });
    const plugins = [ssoOidc(), other];
    expect(collectRegistrations(plugins).bindings.get('identity')).toBe('other-identity');
    expect([...build(plugins, () => undefined).keys()]).toEqual([oidc.id]);
  });

  it.each([undefined, '', '  ', '[]'])('binds with an empty map for env %j', (raw) => {
    const plugin = ssoOidc({ runtimeProviders: true });
    expect(collectRegistrations([plugin]).bindings.get('identity')).toBe(plugin.id);
    const { providers, env } = fromRaw(plugin, raw);
    expect(providers.size).toBe(0);
    expect(env.mock.calls).toEqual([[RUNTIME_PROVIDERS_VARIABLE]]);
    expect(diagnostics()).toEqual([]);
  });

  it('builds runtime OIDC and Access entries without diagnostics', () => {
    const { providers, env } = fromRaw(
      ssoOidc({ runtimeProviders: true }),
      JSON.stringify([oidc, access]),
    );
    expect([...providers.keys()]).toEqual([oidc.id, access.id]);
    expect(providers.get(oidc.id)?.trustAnchor).toBe(`oidc:${oidc.issuer}`);
    expect(providers.get(access.id)?.trustAnchor).toBe(
      `access:${access.teamDomain}/${access.audience}`,
    );
    expect(env.mock.calls).toEqual([[RUNTIME_PROVIDERS_VARIABLE]]);
    expect(diagnostics()).toEqual([]);
  });

  it('replaces a compiled provider with the env version of its id', () => {
    const sentinel = 'sentinel-private-value';
    const plugin = ssoOidc({ providers: [oidc], runtimeProviders: true });
    const replacement = {
      ...oidc,
      issuer: `https://${sentinel}.example.com`,
      displayName: sentinel,
      clientId: sentinel,
      policy: { verifiedDomains: [`${sentinel}.example.com`], autoJoin: false },
    };
    const { providers } = fromRaw(plugin, JSON.stringify([replacement]));
    expect(providers.size).toBe(1);
    expect(providers.get(oidc.id)?.trustAnchor).toBe(`oidc:${replacement.issuer}`);
    expect(providers.get(oidc.id)?.displayName).toBe(replacement.displayName);
    expect(diagnostics()).toEqual([{ event: 'sso.runtime_providers', overridden: oidc.id }]);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(sentinel);
  });

  it('suppresses a compiled id when its runtime replacement is invalid', () => {
    const plugin = ssoOidc({ providers: [oidc, access], runtimeProviders: true });
    const { providers } = fromRaw(
      plugin,
      JSON.stringify([{ ...oidc, issuer: 'http://invalid.example.com' }]),
    );
    expect([...providers.keys()]).toEqual([access.id]);
    expect(diagnostics()).toEqual([
      { event: 'sso.runtime_providers', index: 0, id: oidc.id, codes: expect.any(Array) },
      { event: 'sso.runtime_providers', suppressed: oidc.id },
    ]);
  });

  it('keeps compiled providers on a malformed runtime document', () => {
    const { providers } = fromRaw(ssoOidc({ providers: [oidc], runtimeProviders: true }), '{');
    expect([...providers.keys()]).toEqual([oidc.id]);
    expect(diagnostics()).toEqual([{ event: 'sso.runtime_providers', documentProblem: 'syntax' }]);
  });

  it.each([false, true])(
    'keeps compiled providers after an unreadable env (compiled: %j)',
    (compiled) => {
      const plugin = ssoOidc({ providers: compiled ? [oidc] : [], runtimeProviders: true });
      const env = vi.fn(() => {
        throw new Error('sentinel-private-value');
      });
      expect([...build([plugin], env).keys()]).toEqual(compiled ? [oidc.id] : []);
      expect(env.mock.calls).toEqual([[RUNTIME_PROVIDERS_VARIABLE]]);
      expect(diagnostics()).toEqual([
        { event: 'sso.runtime_providers', documentProblem: 'unreadable' },
      ]);
    },
  );

  it.each([
    [false, 'oidc'],
    [true, 'oidc'],
    [false, 'cloudflare-access'],
    [true, 'cloudflare-access'],
  ] as const)(
    'propagates compiled constructor failures (runtime: %j, kind: %s)',
    (runtimeProviders, kind) => {
      const thrown = new TypeError('sentinel-private-value');
      if (kind === 'oidc') {
        vi.spyOn(oidcModule, 'createOidcProvider').mockImplementation(() => {
          throw thrown;
        });
      } else {
        vi.spyOn(accessModule, 'createCloudflareAccessProvider').mockImplementation(() => {
          throw thrown;
        });
      }
      const plugin = ssoOidc({ providers: [kind === 'oidc' ? oidc : access], runtimeProviders });
      const raw = JSON.stringify([kind === 'oidc' ? access : oidc]);
      expect(() => plugin.identityProviders?.(context(() => raw))).toThrow(thrown);
      expect(() => fromRaw(plugin, raw)).toThrow(KernelConfigError);
      expect(() => fromRaw(plugin, raw)).toThrow('identity factory threw TypeError');
      expect(diagnostics()).toEqual([]);
    },
  );

  it.each([undefined, false])('ignores env when runtimeProviders is %j', (runtimeProviders) => {
    const plugin = ssoOidc({
      providers: [oidc],
      ...(runtimeProviders === undefined ? {} : { runtimeProviders }),
    });
    const { providers, env } = fromRaw(
      plugin,
      JSON.stringify([{ ...oidc, issuer: 'https://new.example.com' }]),
    );
    expect(providers.size).toBe(1);
    expect(providers.get(oidc.id)?.trustAnchor).toBe(`oidc:${oidc.issuer}`);
    expect(env).not.toHaveBeenCalled();
    expect(diagnostics()).toEqual([]);
  });

  it('reads a fresh env once on each invocation of the same registered factory', () => {
    const plugin = ssoOidc({ runtimeProviders: true });
    const registration = collectRegistrations([plugin]);
    const env = vi
      .fn<IdentityContext['env']>()
      .mockReturnValueOnce(JSON.stringify([oidc]))
      .mockReturnValueOnce(JSON.stringify([access]));
    const ctx = context(env);
    const first = buildIdentityProviders(registration, [plugin], ctx);
    const second = buildIdentityProviders(registration, [plugin], ctx);
    expect([...first.keys()]).toEqual([oidc.id]);
    expect([...second.keys()]).toEqual([access.id]);
    expect(env.mock.calls).toEqual([[RUNTIME_PROVIDERS_VARIABLE], [RUNTIME_PROVIDERS_VARIABLE]]);
  });

  it.each(['oidc', 'cloudflare-access'] as const)(
    'isolates a throwing %s constructor without restoring compiled fallback',
    (kind) => {
      const sentinel = 'sentinel-private-value';
      const plugin = ssoOidc({ providers: [oidc, access], runtimeProviders: true });
      if (kind === 'oidc') {
        vi.spyOn(oidcModule, 'createOidcProvider').mockImplementation(() => {
          throw new TypeError('secret constructor message');
        });
      } else {
        vi.spyOn(accessModule, 'createCloudflareAccessProvider').mockImplementation(() => {
          throw new TypeError('secret constructor message');
        });
      }
      const failed = {
        ...(kind === 'oidc'
          ? { ...oidc, issuer: `https://${sentinel}.example.com`, clientId: sentinel }
          : access),
        displayName: sentinel,
        policy: { verifiedDomains: [`${sentinel}.example.com`], autoJoin: false },
      };
      const { providers } = fromRaw(plugin, JSON.stringify([failed]));
      expect([...providers.keys()]).toEqual([kind === 'oidc' ? access.id : oidc.id]);
      expect(diagnostics()).toEqual([
        { event: 'sso.runtime_providers', overridden: failed.id },
        { event: 'sso.runtime_providers', id: failed.id, code: 'construction_failed' },
      ]);
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(sentinel);
    },
  );

  it('reports displaced and overflow ids individually', () => {
    const sentinel = 'sentinel-private-value';
    const compiled = Array.from({ length: 64 }, (_, index) => ({
      ...oidc,
      id: `p${index}`,
      issuer: `https://p${index}.example.com`,
    }));
    const plugin = ssoOidc({ providers: compiled, runtimeProviders: true });
    const { providers } = fromRaw(
      plugin,
      JSON.stringify([
        {
          ...oidc,
          id: 'replacement',
          issuer: compiled[0]?.issuer,
          displayName: sentinel,
          clientId: sentinel,
          policy: { verifiedDomains: [`${sentinel}.example.com`], autoJoin: false },
        },
        { ...oidc, id: 'overflow', issuer: 'https://overflow.example.com' },
      ]),
    );
    expect(providers.size).toBe(64);
    expect(providers.has('p0')).toBe(false);
    expect(providers.has('replacement')).toBe(true);
    expect(providers.has('overflow')).toBe(false);
    expect(diagnostics()).toEqual([
      { event: 'sso.runtime_providers', displaced: { compiled: 'p0', by: 'replacement' } },
      { event: 'sso.runtime_providers', overflow: 'overflow' },
    ]);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(sentinel);
  });

  it('never emits provider values, problem strings, or error messages', () => {
    const sentinel = 'sentinel-private-value';
    const plugin = ssoOidc({ runtimeProviders: true });
    const { providers } = fromRaw(
      plugin,
      JSON.stringify([
        {
          ...oidc,
          issuer: `http://${sentinel}.example.com`,
          displayName: sentinel,
          clientId: sentinel,
          policy: { verifiedDomains: [sentinel], autoJoin: false },
        },
        { ...oidc, id: sentinel + '@invalid', issuer: `https://${sentinel}.example.com` },
      ]),
    );
    expect(providers.size).toBe(0);
    expect(diagnostics()).toEqual([
      { event: 'sso.runtime_providers', index: 0, id: oidc.id, codes: expect.any(Array) },
      { event: 'sso.runtime_providers', index: 1, codes: expect.any(Array) },
    ]);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(sentinel);
  });

  it('omits a construction error name carrying a provider value', () => {
    const sentinel = 'sentinel-private-value';
    vi.spyOn(oidcModule, 'createOidcProvider').mockImplementation(() => {
      throw Object.assign(new Error(sentinel), { name: sentinel });
    });
    expect(
      fromRaw(ssoOidc({ runtimeProviders: true }), JSON.stringify([oidc, access])).providers.size,
    ).toBe(1);
    expect(diagnostics()).toEqual([
      { event: 'sso.runtime_providers', id: oidc.id, code: 'construction_failed' },
    ]);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(sentinel);
  });

  it('does not invoke a throwing error name getter', () => {
    const getter = vi.fn(() => {
      throw new Error('sentinel-private-value');
    });
    const thrown = Object.defineProperty(new Error('sentinel-private-value'), 'name', {
      get: getter,
    });
    vi.spyOn(oidcModule, 'createOidcProvider').mockImplementation(() => {
      throw thrown;
    });
    const { providers } = fromRaw(
      ssoOidc({ runtimeProviders: true }),
      JSON.stringify([oidc, access]),
    );
    expect([...providers.keys()]).toEqual([access.id]);
    expect(diagnostics()).toEqual([
      { event: 'sso.runtime_providers', id: oidc.id, code: 'construction_failed' },
    ]);
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      'sentinel-private-value',
    );
  });

  it('continues with a throwing console for rejection, planning and construction diagnostics', () => {
    vi.mocked(console.warn).mockImplementation(() => {
      throw new Error('sink unavailable');
    });
    const constructor = vi.spyOn(oidcModule, 'createOidcProvider').mockImplementation(() => {
      throw new Error('construction failed');
    });
    const plugin = ssoOidc({ providers: [oidc], runtimeProviders: true });
    const { providers } = fromRaw(
      plugin,
      JSON.stringify([oidc, access, { id: 'invalid', kind: 'unknown' }]),
    );
    expect([...providers.keys()]).toEqual([access.id]);
    expect(console.warn).toHaveBeenCalledTimes(3);
    constructor.mockRestore();
    expect(fromRaw(plugin, '{').providers.size).toBe(1);
    expect([
      ...build([plugin], () => {
        throw new Error('unreadable');
      }).keys(),
    ]).toEqual([oidc.id]);
  });

  it.each(['yes', null, 1, {}])('rejects a non-boolean runtimeProviders option %j', (value) => {
    expect(() => ssoOidc({ runtimeProviders: value as never })).toThrow(TypeError);
    expect(() => ssoOidc({ runtimeProviders: value as never })).toThrow(
      'invalid sso-oidc configuration: runtimeProviders must be a boolean',
    );
  });

  it('reports an unreadable runtimeProviders option through the configuration TypeError', () => {
    expect(() =>
      ssoOidc({
        get runtimeProviders(): never {
          throw new Error('private');
        },
      }),
    ).toThrow('invalid sso-oidc configuration: runtimeProviders must be readable');
  });
});
