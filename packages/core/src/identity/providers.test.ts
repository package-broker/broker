import { describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../ids.js';
import { KernelConfigError, collectRegistrations, type Registration } from '../kernel/registry.js';
import { SUPPORTED_PLUGIN_API, type PluginDefinition } from '../plugin.js';
import type { IdentityContext, IdentityProvider, IdentityProviderFactory } from './port.js';
import {
  PROVIDER_SECRET_SUFFIXES,
  buildIdentityProviders,
  providerSecretName,
  scopedEnv,
} from './providers.js';

const HEX_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const HEX_B = 'b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const ctx: IdentityContext = {
  fetch: () => Promise.resolve(new Response(null)),
  clock: fixedClock('2026-10-15T00:00:00.000Z'),
  env: () => undefined,
};

function label(index: number): string {
  return `plugin "sso" identity provider[${index}]`;
}

function provider(
  overrides: Partial<Record<keyof IdentityProvider, unknown>> = {},
): IdentityProvider {
  return {
    id: 'dex',
    kind: 'oidc',
    displayName: 'Dex',
    trustAnchor: 'oidc:https://dex.example.com',
    policy: { verifiedDomains: ['example.com'], autoJoin: false },
    supportsReauth: true,
    start: () => Promise.resolve({ kind: 'direct' }),
    finish: () => Promise.resolve({ ok: false, reason: 'missing_credentials' }),
    ...overrides,
  } as IdentityProvider;
}

function plugin(id: string, factory?: IdentityProviderFactory): PluginDefinition {
  return {
    id,
    package: `@test/${id}`,
    apiVersion: SUPPORTED_PLUGIN_API[0],
    platforms: ['node'],
    ...(factory === undefined ? {} : { binds: ['identity'], identityProviders: factory }),
  };
}

function build(
  factory: IdentityProviderFactory | undefined,
  context: IdentityContext = ctx,
): ReturnType<typeof buildIdentityProviders> {
  const plugins = [plugin('sso', factory)];
  return buildIdentityProviders(collectRegistrations(plugins), plugins, context);
}

function errorOf(factory: IdentityProviderFactory): KernelConfigError {
  try {
    build(factory);
  } catch (error) {
    expect(error).toBeInstanceOf(KernelConfigError);
    return error as KernelConfigError;
  }
  throw new Error('expected KernelConfigError');
}

function problemsOf(factory: IdentityProviderFactory): readonly string[] {
  return errorOf(factory).problems;
}

describe('scopedEnv', () => {
  it('passes only PB_IDP_ names', () => {
    const read = scopedEnv({ PB_IDP_DEX_CLIENT_SECRET: 's', PB_MASTER_KEY: 'k' });
    expect(read('PB_IDP_DEX_CLIENT_SECRET')).toBe('s');
    expect(read('PB_MASTER_KEY')).toBeUndefined();
  });

  it('ignores non-string values, inherited names and absent names', () => {
    const inherited = Object.create({ PB_IDP_INHERITED: 'x' }) as Record<string, unknown>;
    inherited.PB_IDP_NUMBER = 42;
    inherited.PB_IDP_BINDING = {};
    inherited.PB_IDP_EMPTY = '';
    const read = scopedEnv(inherited);
    expect(read('PB_IDP_INHERITED')).toBeUndefined();
    expect(read('PB_IDP_NUMBER')).toBeUndefined();
    expect(read('PB_IDP_BINDING')).toBeUndefined();
    expect(read('PB_IDP_ABSENT')).toBeUndefined();
    expect(read('PB_IDP_EMPTY')).toBe('');
  });

  it('does not expose names outside the prefix', () => {
    const read = scopedEnv({ PB_IDPX: 'a', pb_idp_lower: 'b', PB_IDP: 'c' });
    expect(read('PB_IDPX')).toBeUndefined();
    expect(read('pb_idp_lower')).toBeUndefined();
    expect(read('PB_IDP')).toBeUndefined();
    expect(read('__proto__')).toBeUndefined();
  });

  it('refuses a name that is not a string primitive', () => {
    const lookups: string[] = [];
    const env = new Proxy({ PB_MASTER_KEY: 'k', PB_IDP_X: 'x' } as Record<string, unknown>, {
      has: (target, key) => {
        lookups.push(String(key));
        return key in target;
      },
    });
    const read = scopedEnv(env);
    const disguised = {
      startsWith: () => true,
      toString: () => 'PB_MASTER_KEY',
      [Symbol.toPrimitive]: () => 'PB_MASTER_KEY',
    };
    expect(read(disguised as unknown as string)).toBeUndefined();
    expect(read(['PB_MASTER_KEY'] as unknown as string)).toBeUndefined();
    expect(read(undefined as unknown as string)).toBeUndefined();
    expect(read(null as unknown as string)).toBeUndefined();
    expect(lookups).toEqual([]);
  });

  it('never calls toString on a name that is not a string', () => {
    const calls = { value: 0 };
    const flipping = {
      toString: () => {
        calls.value += 1;
        return calls.value === 1 ? 'PB_IDP_X' : 'PB_MASTER_KEY';
      },
    };
    const read = scopedEnv({ PB_IDP_X: 'x', PB_MASTER_KEY: 'k' });
    expect(read(flipping as unknown as string)).toBeUndefined();
    expect(calls.value).toBe(0);
  });
});

describe('providerSecretName', () => {
  it('lists the allowed suffixes', () => {
    expect(PROVIDER_SECRET_SUFFIXES).toEqual(['CLIENT_ID', 'CLIENT_SECRET']);
    expect(Object.isFrozen(PROVIDER_SECRET_SUFFIXES)).toBe(true);
  });

  it('upper-cases the id and joins the suffix', () => {
    expect(providerSecretName('dex', 'CLIENT_SECRET')).toBe('PB_IDP_DEX_CLIENT_SECRET');
    expect(providerSecretName('my-idp', 'CLIENT_ID')).toBe('PB_IDP_MY_IDP_CLIENT_ID');
  });

  it.each([
    ['uppercase id', 'Dex', 'CLIENT_SECRET'],
    ['empty id', '', 'CLIENT_SECRET'],
    ['reserved id', 'local', 'CLIENT_SECRET'],
    ['empty suffix', 'dex', ''],
    ['lowercase suffix', 'dex', 'client_secret'],
    ['suffix with a dash', 'dex', 'CLIENT-SECRET'],
    ['a well-formed suffix outside the list', 'dex', 'SECRET'],
    ['a suffix that would collide', 'dex-client', 'ID'],
  ])('refuses %s', (_label, id, suffix) => {
    expect(() => providerSecretName(id, suffix)).toThrow(RangeError);
  });

  it('never maps two (id, suffix) pairs to one name', () => {
    const names = ['dex', 'dex-client', 'dex-client-id'].flatMap((id) =>
      PROVIDER_SECRET_SUFFIXES.map((suffix) => providerSecretName(id, suffix)),
    );
    expect(names).toHaveLength(6);
    expect(new Set(names).size).toBe(6);
  });
});

describe('buildIdentityProviders', () => {
  it('returns an empty map when no plugin binds identity', () => {
    const plugins = [plugin('plain')];
    const map = buildIdentityProviders(collectRegistrations(plugins), plugins, ctx);
    expect(map.size).toBe(0);
    expect([...map.keys()]).toEqual([]);
    expect(map.has('dex')).toBe(false);
    expect(map.get('dex')).toBeUndefined();
  });

  it('builds two providers in factory order and calls the factory once', () => {
    const factory = vi.fn<IdentityProviderFactory>(() => [
      provider({ id: 'zeta', trustAnchor: 'oidc:https://zeta.example.com' }),
      provider({
        id: 'access',
        kind: 'cloudflare-access',
        trustAnchor: `access:team.cloudflareaccess.com/${HEX_A}`,
        supportsReauth: false,
      }),
    ]);
    const map = build(factory);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(map.size).toBe(2);
    expect([...map.keys()]).toEqual(['zeta', 'access']);
    expect([...map.values()].map((p) => p.id)).toEqual(['zeta', 'access']);
    expect(map.has('access')).toBe(true);
    expect(map.get('access')).toMatchObject({
      id: 'access',
      kind: 'cloudflare-access',
      displayName: 'Dex',
      supportsReauth: false,
    });
  });

  it('hands the factory a frozen copy of the context', () => {
    const mutable = { ...ctx } as { -readonly [K in keyof IdentityContext]: IdentityContext[K] };
    let received: IdentityContext | undefined;
    build((given) => {
      received = given;
      return [];
    }, mutable);
    expect(received).not.toBe(mutable);
    expect(Object.isFrozen(received)).toBe(true);
    expect(received!.fetch).toBe(ctx.fetch);
    expect(received!.clock).not.toBe(ctx.clock);
    expect(Object.isFrozen(received!.clock)).toBe(true);
    expect(Object.keys(received!.clock)).toEqual(['now']);
    expect(received!.clock.now().toISOString()).toBe(ctx.clock.now().toISOString());
    expect(Object.keys(received!).sort()).toEqual(['clock', 'env', 'fetch']);
    mutable.env = () => 'changed';
    expect(received!.env('PB_IDP_X')).toBeUndefined();
  });

  it('scopes the environment the factory sees to PB_IDP_ names with string values', () => {
    const complete: Record<string, unknown> = {
      PB_MASTER_KEY: 'master',
      PB_IDP_DEX_CLIENT_SECRET: 'dex-secret',
      PB_IDP_NUMBER: 42,
    };
    const reads: string[] = [];
    const callerEnv = (name: string): string | undefined => {
      reads.push(name);
      return complete[name] as string | undefined;
    };
    let seen: IdentityContext['env'] | undefined;
    build(
      (given) => {
        seen = given.env;
        return [];
      },
      { ...ctx, env: callerEnv },
    );
    expect(seen!('PB_IDP_DEX_CLIENT_SECRET')).toBe('dex-secret');
    expect(seen!('PB_MASTER_KEY')).toBeUndefined();
    expect(seen!('PB_IDP_NUMBER')).toBeUndefined();
    expect(seen!({ startsWith: () => true } as unknown as string)).toBeUndefined();
    expect(reads).toEqual(['PB_IDP_DEX_CLIENT_SECRET', 'PB_IDP_NUMBER']);
  });

  it('accepts an already scoped reader', () => {
    let seen: IdentityContext['env'] | undefined;
    build(
      (given) => {
        seen = given.env;
        return [];
      },
      { ...ctx, env: scopedEnv({ PB_IDP_A: 'a', PB_MASTER_KEY: 'k' }) },
    );
    expect(seen!('PB_IDP_A')).toBe('a');
    expect(seen!('PB_MASTER_KEY')).toBeUndefined();
  });

  it('delegates start and finish to the original provider', async () => {
    const original = provider();
    const start = vi.spyOn(original, 'start');
    const finish = vi.spyOn(original, 'finish');
    const map = build(() => [original]);
    const wrapped = map.get('dex')!;
    const request = new Request('https://broker.example.com/');
    await wrapped.start({
      request,
      purpose: 'login',
      callbackUrl: 'https://broker.example.com/cb',
    });
    await wrapped.finish({
      request,
      state: null,
      callbackUrl: 'https://broker.example.com/cb',
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(start.mock.contexts[0]).toBe(original);
  });

  it('exposes a frozen read-only view', () => {
    const map = build(() => [provider()]);
    const loose = map as unknown as Record<string, unknown>;
    expect(loose.set).toBeUndefined();
    expect(loose.delete).toBeUndefined();
    expect(loose.clear).toBeUndefined();
    expect(Object.isFrozen(map)).toBe(true);
    expect(() => {
      loose.size = 99;
    }).toThrow(TypeError);
    expect(() => {
      loose.get = () => undefined;
    }).toThrow(TypeError);
    expect(() => {
      loose.set = () => undefined;
    }).toThrow(TypeError);
    expect(map.size).toBe(1);
    expect(map.get('dex')).toBeDefined();
  });

  it('cannot gain entries after build from anything the plugin holds', () => {
    const list: IdentityProvider[] = [provider()];
    const map = build(() => list);
    list.push(provider({ id: 'late', trustAnchor: 'oidc:https://late.example.com' }));
    list.length = 0;
    expect(map.size).toBe(1);
    expect([...map.keys()]).toEqual(['dex']);
    expect(map.has('late')).toBe(false);
  });

  it('copies and freezes the policy at build time', () => {
    const domains = ['example.com'];
    const policy = { verifiedDomains: domains, autoJoin: false };
    const map = build(() => [provider({ policy })]);
    domains.push('evil.example');
    policy.autoJoin = true;
    const seen = map.get('dex')!.policy;
    expect(seen.verifiedDomains).toEqual(['example.com']);
    expect(seen.autoJoin).toBe(false);
    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen.verifiedDomains)).toBe(true);
    expect(map.get('dex')!.policy).toBe(seen);
  });

  it('copies and freezes email-authoritative domains at build time', () => {
    const emailAuthoritativeDomains = ['example.com'];
    const map = build(() => [
      provider({
        policy: { verifiedDomains: ['example.com'], emailAuthoritativeDomains, autoJoin: false },
      }),
    ]);
    emailAuthoritativeDomains.length = 0;
    const seen = map.get('dex')!.policy.emailAuthoritativeDomains;
    expect(seen).toEqual(['example.com']);
    expect(Object.isFrozen(seen)).toBe(true);
  });

  it('snapshots scalar fields at build time', () => {
    const original = provider() as { id: string; trustAnchor: string; displayName: string };
    const map = build(() => [original as unknown as IdentityProvider]);
    original.id = 'other';
    original.trustAnchor = 'oidc:https://other.example.com';
    original.displayName = 'Other';
    expect(map.get('dex')!.id).toBe('dex');
    expect(map.get('dex')!.trustAnchor).toBe('oidc:https://dex.example.com');
    expect(map.get('dex')!.displayName).toBe('Dex');
  });

  it('reads every field once, so a getter that changes its answer is not trusted twice', () => {
    const reads: Record<string, number> = {};
    const answers: Record<string, [unknown, unknown]> = {
      id: ['dex', 'BAD'],
      kind: ['oidc', 'saml'],
      displayName: ['Dex', ''],
      trustAnchor: ['oidc:https://dex.example.com', 'nope'],
      supportsReauth: [true, 'x'],
      start: [() => Promise.resolve({ kind: 'direct' }), 'x'],
      finish: [() => Promise.resolve({ ok: false, reason: 'missing_credentials' }), 'x'],
    };
    const hostile = {} as Record<string, unknown>;
    for (const [key, [first, later]] of Object.entries(answers)) {
      Object.defineProperty(hostile, key, {
        enumerable: true,
        get() {
          reads[key] = (reads[key] ?? 0) + 1;
          return reads[key] === 1 ? first : later;
        },
      });
    }
    const policyReads = { policy: 0, domains: 0, autoJoin: 0 };
    Object.defineProperty(hostile, 'policy', {
      enumerable: true,
      get() {
        policyReads.policy += 1;
        const policy = {};
        Object.defineProperty(policy, 'verifiedDomains', {
          get() {
            policyReads.domains += 1;
            return policyReads.domains === 1 ? ['example.com'] : [];
          },
        });
        Object.defineProperty(policy, 'autoJoin', {
          get() {
            policyReads.autoJoin += 1;
            return policyReads.autoJoin === 1 ? false : 'x';
          },
        });
        return policy;
      },
    });
    const map = build(() => [hostile as unknown as IdentityProvider]);
    expect(reads).toEqual({
      id: 1,
      kind: 1,
      displayName: 1,
      trustAnchor: 1,
      supportsReauth: 1,
      start: 1,
      finish: 1,
    });
    expect(policyReads).toEqual({ policy: 1, domains: 1, autoJoin: 1 });
    expect(map.get('dex')).toMatchObject({
      id: 'dex',
      kind: 'oidc',
      displayName: 'Dex',
      supportsReauth: true,
      policy: { verifiedDomains: ['example.com'], autoJoin: false },
    });
  });

  it('accepts exactly 64 providers and a display name of 100 characters', () => {
    const list = Array.from({ length: 64 }, (_, i) =>
      provider({
        id: `p${i}`,
        displayName: 'x'.repeat(100),
        trustAnchor: `oidc:https://p${i}.example.com`,
      }),
    );
    expect(build(() => list).size).toBe(64);
  });

  describe('problems', () => {
    it.each([
      ['an object', () => ({}) as never],
      ['null', () => null as never],
      ['a promise', () => Promise.resolve([]) as never],
    ])('rejects %s as a result', (_label, factory) => {
      expect(problemsOf(factory)).toEqual(['plugin "sso" identity factory must return an array']);
    });

    it('rejects more than 64 providers before looking at any of them', () => {
      const probe = vi.fn(() => 'dex');
      const list = Array.from({ length: 65 }, () => ({
        get id() {
          return probe();
        },
      }));
      expect(problemsOf(() => list as never)).toEqual([
        'plugin "sso" identity factory returned more than 64 providers',
      ]);
      expect(probe).not.toHaveBeenCalled();
    });

    it('rejects elements that are not objects', () => {
      expect(problemsOf(() => [null, 'x'] as never)).toEqual([
        `${label(0)} must be an object`,
        `${label(1)} must be an object`,
      ]);
    });

    it('treats a hole in a sparse array like any other missing provider', () => {
      expect(problemsOf(() => new Array(1) as never)).toEqual([`${label(0)} must be an object`]);
      const sparse: unknown[] = [provider()];
      sparse.length = 2;
      sparse[2] = provider({ id: 'b', trustAnchor: 'oidc:https://b.example.com' });
      expect(problemsOf(() => sparse as never)).toEqual([`${label(1)} must be an object`]);
    });

    it.each([
      ['an uppercase id', 'Dex', 'string'],
      ['an empty id', '', 'string'],
      ['an id with a slash', 'a/b', 'string'],
      ['a non-string id', 42, 'number'],
      ['an object id', { toString: () => 'dex' }, 'object'],
    ])('rejects %s without echoing it', (_label, id, type) => {
      expect(problemsOf(() => [provider({ id })])).toEqual([
        `${label(0)} id is not a valid provider id (type ${type})`,
      ]);
    });

    it('does not call the toString of a plugin-supplied id', () => {
      const toString = vi.fn(() => 'secret-SENTINEL-123');
      const problems = problemsOf(() => [provider({ id: { toString } })]);
      expect(toString).not.toHaveBeenCalled();
      expect(problems.join('\n')).not.toContain('SENTINEL');
    });

    it('does not echo an invalid string id', () => {
      const problems = problemsOf(() => [provider({ id: 'Dex\nINJECTED line' })]);
      expect(problems).toEqual([`${label(0)} id is not a valid provider id (type string)`]);
    });

    it('rejects the reserved id local', () => {
      expect(problemsOf(() => [provider({ id: 'local' })])).toEqual([
        `${label(0)} id "local" is reserved`,
      ]);
    });

    it('rejects a duplicate id', () => {
      expect(
        problemsOf(() => [provider(), provider({ trustAnchor: 'oidc:https://other.example.com' })]),
      ).toEqual([`${label(1)} id "dex" duplicates provider[0]`]);
    });

    it.each([['saml'], ['OIDC'], [''], [7]])('rejects kind %j', (kind) => {
      expect(problemsOf(() => [provider({ kind })])).toEqual([
        `${label(0)} kind must be "cloudflare-access" or "oidc"`,
      ]);
    });

    it.each([
      ['an http issuer', 'oidc:http://dex.example.com'],
      ['a bare host', 'dex.example.com'],
      ['a short audience', 'access:team.example.com/abc'],
      ['an empty anchor', ''],
      ['a non-string anchor', 12],
    ])('rejects %s as trust anchor', (_label, trustAnchor) => {
      expect(problemsOf(() => [provider({ trustAnchor })])).toEqual([
        `${label(0)} trustAnchor is not a valid trust anchor`,
      ]);
    });

    it('rejects a trust anchor shared by two providers', () => {
      expect(problemsOf(() => [provider(), provider({ id: 'dex2' })])).toEqual([
        `${label(1)} trustAnchor duplicates provider[0]`,
      ]);
    });

    it.each([
      ['a different case of the host', 'oidc:https://DEX.Example.com'],
      ['the default port', 'oidc:https://dex.example.com:443'],
      ['a trailing slash', 'oidc:https://dex.example.com/'],
      ['a trailing dot on the host', 'oidc:https://dex.example.com.'],
      ['all of them', 'oidc:https://DEX.example.com.:443/'],
    ])('treats %s as the same trust anchor', (_label, variant) => {
      expect(
        problemsOf(() => [provider(), provider({ id: 'dex2', trustAnchor: variant })]),
      ).toEqual([`${label(1)} trustAnchor duplicates provider[0]`]);
    });

    it.each([
      ['a percent-encoded hyphen', 'oidc:https://dex.example.com/realm%2Da', '/realm-a'],
      ['a percent-encoded tilde', 'oidc:https://dex.example.com/r%7Ea', '/r~a'],
      ['lower-case escape hex', 'oidc:https://dex.example.com/a%2fb', '/a%2Fb'],
    ])('compares %s on its decoded form', (_label, first, second) => {
      expect(
        problemsOf(() => [
          provider({ trustAnchor: first }),
          provider({ id: 'dex2', trustAnchor: `oidc:https://dex.example.com${second}` }),
        ]),
      ).toEqual([`${label(1)} trustAnchor duplicates provider[0]`]);
    });

    it('keeps an encoded slash apart from a real one', () => {
      expect(
        build(() => [
          provider({ id: 'a', trustAnchor: 'oidc:https://dex.example.com/a%2Fb' }),
          provider({ id: 'b', trustAnchor: 'oidc:https://dex.example.com/a/b' }),
        ]).size,
      ).toBe(2);
    });

    it('keeps different paths and ports apart and the stored anchor verbatim', () => {
      const map = build(() => [
        provider({ id: 'a', trustAnchor: 'oidc:https://Dex.example.com/realm-a' }),
        provider({ id: 'b', trustAnchor: 'oidc:https://dex.example.com/realm-b' }),
        provider({ id: 'c', trustAnchor: 'oidc:https://dex.example.com:8443' }),
      ]);
      expect(map.size).toBe(3);
      expect(map.get('a')!.trustAnchor).toBe('oidc:https://Dex.example.com/realm-a');
    });

    it.each([
      ['an empty string', ''],
      ['a string over 100 characters', 'x'.repeat(101)],
      ['a newline', 'a\nb'],
      ['a zero-width space', 'a​b'],
      ['a right-to-left override', '‮a'],
      ['a lone high surrogate', 'a\uD800b'],
      ['a lone low surrogate', 'a\uDC00'],
      ['a number', 42],
      ['undefined', undefined],
    ])('rejects a displayName with %s', (_label, displayName) => {
      expect(problemsOf(() => [provider({ displayName })])).toEqual([
        `${label(0)} displayName must be 1 to 100 characters without control or format characters`,
      ]);
    });

    it('accepts a display name with a well-formed surrogate pair', () => {
      expect(build(() => [provider({ displayName: 'Dex \u{1F510}' })]).size).toBe(1);
    });

    it.each([
      ['oidc with an access anchor', 'oidc', `access:team.cloudflareaccess.com/${HEX_A}`],
      [
        'cloudflare-access with an oidc anchor',
        'cloudflare-access',
        'oidc:https://dex.example.com',
      ],
    ])('rejects %s', (_label, kind, trustAnchor) => {
      expect(problemsOf(() => [provider({ kind, trustAnchor })])).toEqual([
        `${label(0)} kind does not match the trustAnchor prefix`,
      ]);
    });

    it('rejects a verifiedDomains whose length is not a finite safe integer', () => {
      for (const length of [Infinity, -1, 1.5, Number.NaN]) {
        const verifiedDomains = new Proxy(['example.com'], {
          get: (target, key, receiver) =>
            key === 'length' ? length : (Reflect.get(target, key, receiver) as unknown),
        });
        expect(
          problemsOf(() => [provider({ policy: { verifiedDomains, autoJoin: false } })]),
        ).toEqual([`${label(0)} policy: verifiedDomains must be an array of at most 100 entries`]);
      }
    });

    it('caps verifiedDomains at 100 entries', () => {
      const domains = (count: number) =>
        Array.from({ length: count }, (_, i) => `d${i}.example.com`);
      expect(
        build(() => [provider({ policy: { verifiedDomains: domains(100), autoJoin: false } })])
          .size,
      ).toBe(1);
      expect(
        problemsOf(() => [
          provider({ policy: { verifiedDomains: domains(101), autoJoin: false } }),
        ]),
      ).toEqual([`${label(0)} policy: verifiedDomains must be an array of at most 100 entries`]);
    });

    it('caps emailAuthoritativeDomains at 100 entries', () => {
      const verifiedDomains = Array.from({ length: 100 }, (_, i) => `d${i}.example.com`);
      const policy = {
        verifiedDomains,
        emailAuthoritativeDomains: verifiedDomains,
        autoJoin: false,
      };
      expect(build(() => [provider({ policy })]).size).toBe(1);
      expect(
        problemsOf(() => [
          provider({
            policy: {
              ...policy,
              emailAuthoritativeDomains: [...verifiedDomains, verifiedDomains[0]],
            },
          }),
        ]),
      ).toEqual([
        `${label(0)} policy: emailAuthoritativeDomains must be an array of at most 100 entries`,
      ]);
    });

    it('rejects an email-authoritative domain absent from verifiedDomains', () => {
      expect(
        problemsOf(() => [
          provider({
            policy: {
              verifiedDomains: ['example.com'],
              emailAuthoritativeDomains: ['other.example'],
              autoJoin: false,
            },
          }),
        ]),
      ).toEqual([
        `${label(0)} policy: emailAuthoritativeDomains[0] must appear in verifiedDomains`,
      ]);
    });

    it('rejects an empty verifiedDomains list', () => {
      expect(
        problemsOf(() => [provider({ policy: { verifiedDomains: [], autoJoin: false } })]),
      ).toEqual([`${label(0)} policy: verifiedDomains must list at least one domain`]);
    });

    it.each([
      [
        'a wildcard domain',
        { verifiedDomains: ['*.example.com'], autoJoin: false },
        'verifiedDomains[0] must not contain a wildcard',
      ],
      [
        'a non-boolean autoJoin',
        { verifiedDomains: ['example.com'], autoJoin: 'yes' },
        'autoJoin must be a boolean',
      ],
      ['a missing policy', undefined, 'policy must be an object'],
      ['an array policy', [], 'policy must be an object'],
      [
        'a non-array verifiedDomains',
        { verifiedDomains: 'example.com', autoJoin: false },
        'verifiedDomains must be an array',
      ],
    ])('rejects %s', (_label, policy, text) => {
      expect(problemsOf(() => [provider({ policy })])).toEqual([`${label(0)} policy: ${text}`]);
    });

    it.each([['yes'], [1], [undefined]])('rejects supportsReauth %j', (supportsReauth) => {
      expect(problemsOf(() => [provider({ supportsReauth })])).toEqual([
        `${label(0)} supportsReauth must be a boolean`,
      ]);
    });

    it.each([['start'], ['finish']])('rejects a non-function %s', (key) => {
      expect(problemsOf(() => [provider({ [key]: 'nope' })])).toEqual([
        `${label(0)} ${key} must be a function`,
      ]);
    });

    it('lists two problems together', () => {
      expect(
        problemsOf(() => [
          provider({ id: 'local' }),
          provider({ id: 'ok', kind: 'saml', trustAnchor: 'oidc:https://ok.example.com' }),
        ]),
      ).toEqual([
        `${label(0)} id "local" is reserved`,
        `${label(1)} kind must be "cloudflare-access" or "oidc"`,
      ]);
    });

    it('lists every problem of one provider in one error', () => {
      const error = errorOf(() => [
        provider({
          id: 'BAD',
          supportsReauth: 'x',
          policy: { verifiedDomains: [], autoJoin: false },
        }),
      ]);
      expect(error.problems).toEqual([
        `${label(0)} id is not a valid provider id (type string)`,
        `${label(0)} policy: verifiedDomains must list at least one domain`,
        `${label(0)} supportsReauth must be a boolean`,
      ]);
      expect(error.message).toBe(error.problems.join('\n'));
    });

    it('does not let a throwing getter escape', () => {
      const hostile = provider();
      Object.defineProperty(hostile, 'kind', {
        get() {
          throw new Error('secret-SENTINEL-123');
        },
      });
      expect(problemsOf(() => [hostile])).toEqual([`${label(0)} threw Error`]);
    });
  });

  describe('a misbehaving factory result', () => {
    it('records only the error name of a throwing factory', () => {
      const plugins = [
        plugin('sso', () => {
          throw new Error('secret-SENTINEL-123');
        }),
      ];
      const registration = collectRegistrations(plugins);
      let caught: unknown;
      try {
        buildIdentityProviders(registration, plugins, ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(KernelConfigError);
      const error = caught as KernelConfigError;
      expect(error.problems).toEqual(['plugin "sso" identity factory threw Error']);
      expect(error.message).not.toContain('SENTINEL');
      expect(JSON.stringify(error.problems)).not.toContain('SENTINEL');
      expect(error.stack ?? '').not.toContain('SENTINEL');
    });

    it.each([
      ['TypeError'],
      ['RangeError'],
      ['SyntaxError'],
      ['ReferenceError'],
      ['AggregateError'],
      ['DOMException'],
      ['NonError'],
    ])('reports the allowlisted error name %s', (name) => {
      expect(
        problemsOf(() => {
          const error = new Error('x');
          error.name = name;
          throw error;
        }),
      ).toEqual([`plugin "sso" identity factory threw ${name}`]);
    });

    it('reports an error name outside the allowlist as Error', () => {
      class CustomFailure extends Error {
        override name = 'CustomFailure';
      }
      expect(
        problemsOf(() => {
          throw new CustomFailure('SENTINEL');
        }),
      ).toEqual(['plugin "sso" identity factory threw Error']);
      expect(
        problemsOf(() => {
          const error = new Error('x');
          error.name = 'secret_SENTINEL_123';
          throw error;
        }),
      ).toEqual(['plugin "sso" identity factory threw Error']);
    });

    it('ignores a hostile name', () => {
      expect(
        problemsOf(() => {
          const error = new Error('x');
          error.name = 'secret SENTINEL 123';
          throw error;
        }),
      ).toEqual(['plugin "sso" identity factory threw Error']);
      expect(
        problemsOf(() => {
          throw 'secret-SENTINEL-123';
        }),
      ).toEqual(['plugin "sso" identity factory threw Error']);
    });

    it('survives a thrown value whose prototype lookup throws', () => {
      const trap = new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('secret-SENTINEL-123');
          },
        },
      );
      const problems = problemsOf(() => {
        throw trap;
      });
      expect(problems).toEqual(['plugin "sso" identity factory threw Error']);
    });

    it('survives an error whose name getter throws', () => {
      const error = new Error('x');
      Object.defineProperty(error, 'name', {
        get() {
          throw new Error('secret-SENTINEL-123');
        },
      });
      expect(
        problemsOf(() => {
          throw error;
        }),
      ).toEqual(['plugin "sso" identity factory threw Error']);
    });

    it('swallows the rejection of an asynchronous factory', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      const problems = problemsOf((() => Promise.reject(new Error('SENTINEL'))) as never);
      await new Promise((resolve) => setTimeout(resolve, 10));
      process.off('unhandledRejection', unhandled);
      expect(problems).toEqual(['plugin "sso" identity factory must return an array']);
      expect(unhandled).not.toHaveBeenCalled();
    });

    it('turns a result whose length getter throws into one problem', () => {
      const result = new Proxy([] as unknown[], {
        get(target, key, receiver) {
          if (key === 'length') {
            throw new Error('secret-SENTINEL-123');
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      const error = errorOf(() => result as never);
      expect(error.problems).toEqual(['plugin "sso" identity factory result threw Error']);
      expect(error.message).not.toContain('SENTINEL');
    });

    it('turns a result whose then getter throws into one problem', () => {
      const result = new Proxy([] as unknown[], {
        get(target, key, receiver) {
          if (key === 'then') {
            throw new Error('secret-SENTINEL-123');
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      expect(problemsOf(() => result as never)).toEqual([
        'plugin "sso" identity factory result threw Error',
      ]);
    });

    async function unhandledAfter(run: () => void): Promise<unknown[]> {
      const seen: unknown[] = [];
      const listener = (reason: unknown) => seen.push(reason);
      process.on('unhandledRejection', listener);
      try {
        run();
        await new Promise((resolve) => setTimeout(resolve, 20));
      } finally {
        process.off('unhandledRejection', listener);
      }
      return seen;
    }

    it('reports a thenable whose then method throws as not an array', async () => {
      const result = Object.assign([provider()], {
        then() {
          throw new TypeError('secret-SENTINEL-123');
        },
      });
      let problems: readonly string[] = [];
      const seen = await unhandledAfter(() => {
        problems = problemsOf(() => result as never);
      });
      expect(problems).toEqual(['plugin "sso" identity factory must return an array']);
      expect(seen).toEqual([]);
    });

    it('absorbs a rejection two thenables deep', async () => {
      const inner = {
        then: (_resolve: unknown, reject: (reason: unknown) => void) =>
          reject(new Error('secret-SENTINEL-123')),
      };
      const outer = {
        then: (resolve: (value: unknown) => void) => resolve(inner),
      };
      let problems: readonly string[] = [];
      const seen = await unhandledAfter(() => {
        problems = problemsOf(() => outer as never);
      });
      expect(problems).toEqual(['plugin "sso" identity factory must return an array']);
      expect(seen).toEqual([]);
    });

    it('rejects a result whose length is not a finite safe integer', () => {
      for (const length of [Infinity, -1, 1.5, Number.NaN, '2']) {
        const result = new Proxy([] as unknown[], {
          get: (target, key, receiver) =>
            key === 'length' ? length : (Reflect.get(target, key, receiver) as unknown),
        });
        expect(problemsOf(() => result as never)).toEqual([
          'plugin "sso" identity factory must return an array',
        ]);
      }
    });

    it('does not read an inherited index for a hole', () => {
      Object.defineProperty(Array.prototype, '1', {
        configurable: true,
        get() {
          return provider({ id: 'inherited', trustAnchor: 'oidc:https://i.example.com' });
        },
      });
      try {
        const sparse: unknown[] = [provider()];
        sparse.length = 2;
        expect(problemsOf(() => sparse as never)).toEqual([`${label(1)} must be an object`]);
      } finally {
        delete (Array.prototype as unknown as Record<string, unknown>)['1'];
      }
    });

    it('turns an element accessor that throws into one problem', () => {
      const result: unknown[] = [];
      Object.defineProperty(result, 0, {
        get() {
          throw new RangeError('secret-SENTINEL-123');
        },
      });
      expect(problemsOf(() => result as never)).toEqual([
        'plugin "sso" identity factory result threw RangeError',
      ]);
    });

    it('reads then once and never calls methods on the plugin array', () => {
      const thenReads = vi.fn();
      const result = [provider()] as IdentityProvider[] & Record<string | symbol, unknown>;
      Object.defineProperty(result, 'then', {
        get() {
          thenReads();
          return undefined;
        },
      });
      const trap = () => {
        throw new Error('plugin array method called');
      };
      for (const name of ['forEach', 'map', 'slice', 'filter', 'entries', 'values', 'at']) {
        result[name] = trap;
      }
      result[Symbol.iterator] = trap;
      const map = build(() => result);
      expect(map.size).toBe(1);
      expect(thenReads).toHaveBeenCalledTimes(1);
    });
  });

  describe('a binding the registration cannot back', () => {
    it('reports a binding whose factory is missing', () => {
      const plugins = [plugin('sso', () => [])];
      const registration: Registration = {
        ...collectRegistrations(plugins),
        identityFactory: null,
      };
      let caught: unknown;
      try {
        buildIdentityProviders(registration, plugins, ctx);
      } catch (error) {
        caught = error;
      }
      expect((caught as KernelConfigError).problems).toEqual([
        'plugin "sso" binds identity but has no identity factory',
      ]);
    });

    it.each([
      [
        'a plugin list that throws on iteration',
        () =>
          new Proxy([] as PluginDefinition[], {
            get(target, key, receiver) {
              if (key === 'some') {
                throw new Error('secret-SENTINEL-123');
              }
              return Reflect.get(target, key, receiver) as unknown;
            },
          }),
      ],
      [
        'a plugin whose id getter throws',
        () => {
          const hostile = {} as PluginDefinition;
          Object.defineProperty(hostile, 'id', {
            get() {
              throw new Error('secret-SENTINEL-123');
            },
          });
          return [hostile];
        },
      ],
    ])('reports %s as one fixed problem', (_label, makePlugins) => {
      const registration = collectRegistrations([plugin('sso', () => [])]);
      let caught: unknown;
      try {
        buildIdentityProviders(registration, makePlugins(), ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(KernelConfigError);
      expect((caught as KernelConfigError).problems).toEqual([
        'plugin "sso" could not be matched against the plugin list',
      ]);
      expect((caught as KernelConfigError).message).not.toContain('SENTINEL');
    });

    it('reports a binding whose plugin is absent from the list', () => {
      const registration = collectRegistrations([plugin('sso', () => [])]);
      let caught: unknown;
      try {
        buildIdentityProviders(registration, [plugin('other')], ctx);
      } catch (error) {
        caught = error;
      }
      expect((caught as KernelConfigError).problems).toEqual([
        'plugin "sso" binds identity but has no identity factory',
      ]);
    });
  });

  it('keeps distinct anchors of both kinds valid together', () => {
    const map = build(() => [
      provider(),
      provider({
        id: 'access',
        kind: 'cloudflare-access',
        trustAnchor: `access:team.cloudflareaccess.com/${HEX_B}`,
        supportsReauth: false,
      }),
    ]);
    expect(map.size).toBe(2);
  });
});

describe('optional reauth capability resolver', () => {
  it('preserves the receiver and snapshots the optional method', async () => {
    const source = provider({
      reauthCapability: async function (this: IdentityProvider) {
        return this.id === 'dex';
      },
    });
    const wrapped = build(() => [source]).get('dex')!;
    (source as { reauthCapability: IdentityProvider['reauthCapability'] }).reauthCapability =
      async () => false;
    expect(await wrapped.reauthCapability!()).toBe(true);
    expect(build(() => [provider()]).get('dex')!.reauthCapability).toBeUndefined();
  });
  it('rejects a non-callable capability resolver', () => {
    expect(problemsOf(() => [provider({ reauthCapability: true })])).toEqual([
      `${label(0)} reauthCapability must be a function`,
    ]);
  });
});
