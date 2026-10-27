import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_PLUGIN_API,
  type HookMap,
  type PluginDefinition,
  type PluginRegistry,
} from '../plugin.js';
import { KernelConfigError, collectRegistrations } from './registry.js';

function plugin(id: string, overrides: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    id,
    package: `@test/${id}`,
    apiVersion: SUPPORTED_PLUGIN_API[0],
    platforms: ['node'],
    ...overrides,
  };
}

function problemsOf(plugins: readonly PluginDefinition[]): readonly string[] {
  try {
    collectRegistrations(plugins);
  } catch (error) {
    expect(error).toBeInstanceOf(KernelConfigError);
    return (error as KernelConfigError).problems;
  }
  throw new Error('expected KernelConfigError');
}

describe('identity providers in collectRegistrations', () => {
  it('allows an unbound SSO plugin alongside another identity plugin', () => {
    const result = collectRegistrations([
      plugin('sso-oidc', { capabilities: ['sso'] }),
      plugin('other-identity', { binds: ['identity'], identityProviders: () => [] }),
    ]);
    expect(result.bindings.get('identity')).toBe('other-identity');
    expect(result.identityFactory?.({} as never)).toEqual([]);
  });

  it('registers a plugin that binds identity and supplies a factory', () => {
    const result = collectRegistrations([
      plugin('sso', { binds: ['identity'], identityProviders: () => [] }),
    ]);
    expect(result.bindings.get('identity')).toBe('sso');
  });

  it('rejects binds identity without identityProviders', () => {
    expect(problemsOf([plugin('sso', { binds: ['identity'] })])).toEqual([
      'plugin "sso" binds identity but has no identityProviders',
    ]);
  });

  it('rejects identityProviders without binding identity', () => {
    expect(problemsOf([plugin('sso', { identityProviders: () => [] })])).toEqual([
      'plugin "sso" has identityProviders but does not bind identity',
    ]);
    expect(
      problemsOf([
        plugin('sso', {
          apiVersion: 3,
          binds: ['source'],
          sourceProviders: () => [],
          identityProviders: () => [],
        }),
      ]),
    ).toEqual(['plugin "sso" has identityProviders but does not bind identity']);
  });

  it.each([['text'], [42], [null], [{}]])(
    'rejects a non-function identityProviders %j',
    (value) => {
      const definition = plugin('sso', {
        binds: ['identity'],
        identityProviders: value as never,
      });
      expect(problemsOf([definition])).toEqual([
        'plugin "sso" identityProviders must be a function',
      ]);
    },
  );

  it('reports every identity mismatch together with other problems', () => {
    const problems = problemsOf([
      plugin('a', { binds: ['identity'] }),
      plugin('b', { identityProviders: () => [] }),
      plugin('c', {
        apiVersion: 3,
        binds: ['source'],
        sourceProviders: () => [],
        identityProviders: 'x' as never,
      }),
      plugin('core'),
    ]);
    expect(problems).toEqual([
      'plugin "a" binds identity but has no identityProviders',
      'plugin "b" has identityProviders but does not bind identity',
      'plugin "c" identityProviders must be a function',
      'plugin "c" has identityProviders but does not bind identity',
      'plugin id "core" is reserved',
    ]);
  });

  it('still reports a second plugin binding identity', () => {
    const problems = problemsOf([
      plugin('a', { binds: ['identity'], identityProviders: () => [] }),
      plugin('b', { binds: ['identity'], identityProviders: () => [] }),
    ]);
    expect(problems).toEqual(['port "identity" is bound by plugins "a" and "b"']);
  });
});

describe('auth hooks in collectRegistrations', () => {
  const resolve: HookMap['auth.resolveIdentity'] = () => undefined;
  const mapA: HookMap['auth.mapGroups'] = () => undefined;
  const mapB: HookMap['auth.mapGroups'] = (input) => ({ keep: input.groups.slice(0, 1) });
  const check: HookMap['access.check'] = () => undefined;

  it('collects both new hook kinds in registration order with the plugin id', () => {
    const a = plugin('a', {
      register(registry) {
        registry.hook('auth.mapGroups', mapA);
        registry.hook('auth.resolveIdentity', resolve);
        registry.hook('access.check', check);
      },
    });
    const b = plugin('b', {
      register(registry) {
        registry.hook('auth.mapGroups', mapB);
      },
    });

    const { hooks } = collectRegistrations([a, b]);

    expect(hooks['auth.mapGroups']).toEqual([
      { plugin: 'a', handler: mapA },
      { plugin: 'b', handler: mapB },
    ]);
    expect(hooks['auth.resolveIdentity']).toEqual([{ plugin: 'a', handler: resolve }]);
    expect(hooks['access.check']).toEqual([{ plugin: 'a', handler: check }]);
  });

  it('starts every hook list empty', () => {
    const { hooks } = collectRegistrations([plugin('quiet')]);
    expect(hooks['auth.mapGroups']).toEqual([]);
    expect(hooks['auth.resolveIdentity']).toEqual([]);
    expect(hooks['access.check']).toEqual([]);
  });

  it('turns an unknown hook name into a problem instead of dropping it', () => {
    const bad = plugin('bad', {
      register(registry) {
        registry.hook('auth.unknown' as never, (() => ({ deny: true })) as never);
        registry.hook('access.check', check);
      },
    });
    expect(problemsOf([bad])).toEqual(['plugin "bad" registered unknown hook "auth.unknown"']);
  });

  it('reports every unknown hook name', () => {
    const bad = plugin('bad', {
      register(registry) {
        registry.hook('x' as never, check as never);
        registry.hook('y' as never, check as never);
      },
    });
    expect(problemsOf([bad])).toEqual([
      'plugin "bad" registered unknown hook "x"',
      'plugin "bad" registered unknown hook "y"',
    ]);
  });
});

describe('hook registration hardening', () => {
  const check: HookMap['access.check'] = () => undefined;
  const deny: HookMap['access.check'] = () => ({ deny: true });

  it('rejects an async register instead of dropping hooks registered after an await', async () => {
    let lateError: unknown;
    const late = plugin('late', {
      register(registry) {
        registry.hook('access.check', check);
        return Promise.resolve().then(() => {
          try {
            registry.hook('access.check', deny);
          } catch (error) {
            lateError = error;
          }
        }) as never;
      },
    });

    expect(problemsOf([late])).toEqual(['plugin "late" register must be synchronous']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lateError).toBeInstanceOf(Error);
  });

  it('does not leak an unhandled rejection from an async register', async () => {
    const rejecting = plugin('rejecting', {
      register() {
        return Promise.reject(new Error('later')) as never;
      },
    });
    const seen: unknown[] = [];
    const listener = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', listener);
    try {
      expect(problemsOf([rejecting])).toEqual(['plugin "rejecting" register must be synchronous']);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', listener);
    }
    expect(seen).toEqual([]);
  });

  it('seals the registry once register has returned', () => {
    let saved: PluginRegistry | undefined;
    const keeper = plugin('keeper', {
      register(registry) {
        saved = registry;
        registry.hook('access.check', check);
      },
    });

    const result = collectRegistrations([keeper]);

    expect(() => saved?.hook('access.check', deny)).toThrow(Error);
    expect(() =>
      saved?.route({
        method: 'GET',
        path: '/late',
        permission: null,
        handler: () => new Response(),
      }),
    ).toThrow(Error);
    expect(result.hooks['access.check']).toEqual([{ plugin: 'keeper', handler: check }]);
    expect(result.routes).toEqual([]);
  });

  it('rejects a non-function handler for a known hook', () => {
    const bad = plugin('p', {
      register(registry) {
        registry.hook('auth.mapGroups', 'nope' as never);
        registry.hook('access.check', null as never);
      },
    });
    expect(problemsOf([bad])).toEqual([
      'plugin "p" hook "auth.mapGroups" handler must be a function',
      'plugin "p" hook "access.check" handler must be a function',
    ]);
  });

  it('renders a hook name containing a newline as one escaped problem line', () => {
    const bad = plugin('p', {
      register(registry) {
        registry.hook('a\nplugin "evil" has unknown key "x"' as never, check as never);
      },
    });
    const problems = problemsOf([bad]);
    expect(problems).toEqual([
      'plugin "p" registered unknown hook "a\\nplugin \\"evil\\" has unknown key \\"x\\""',
    ]);
    expect(problems[0]).not.toContain('\n');
  });

  it('truncates a long hook name to 80 characters', () => {
    const bad = plugin('p', {
      register(registry) {
        registry.hook('x'.repeat(500) as never, check as never);
      },
    });
    expect(problemsOf([bad])).toEqual([`plugin "p" registered unknown hook "${'x'.repeat(80)}"`]);
  });

  it.each(['__proto__', 'toString', 'constructor', 'hasOwnProperty'])(
    'rejects %s as a hook name',
    (name) => {
      const bad = plugin('p', {
        register(registry) {
          registry.hook(name as never, check as never);
        },
      });
      expect(problemsOf([bad])).toEqual([`plugin "p" registered unknown hook "${name}"`]);
    },
  );

  it('aggregates an unknown hook of one plugin with a problem of another', () => {
    const bad = plugin('bad', {
      register(registry) {
        registry.hook('auth.unknown' as never, check as never);
      },
    });
    const problems = problemsOf([bad, plugin('worse', { binds: ['identity'] })]);
    expect(problems).toEqual([
      'plugin "bad" registered unknown hook "auth.unknown"',
      'plugin "worse" binds identity but has no identityProviders',
    ]);
  });

  it.each([
    [new Error('secret text'), 'Error'],
    [new TypeError('secret text'), 'TypeError'],
    ['secret text', 'Error'],
    [Object.assign(new Error('x'), { name: 'bad\nname' }), 'Error'],
  ])('reports a throwing register by error name only (%#)', (thrown, name) => {
    const boom = plugin('boom', {
      register() {
        throw thrown;
      },
    });
    const problems = problemsOf([boom]);
    expect(problems).toEqual([`plugin "boom" register threw ${name}`]);
  });
});

describe('frozen registration and captured identity factory', () => {
  it('captures the factory once and exposes it on the registration', () => {
    const factory = () => [];
    let reads = 0;
    const definition = plugin('sso', { binds: ['identity'] });
    Object.defineProperty(definition, 'identityProviders', {
      enumerable: true,
      get() {
        reads += 1;
        return factory;
      },
    });

    const result = collectRegistrations([definition]);

    expect(reads).toBe(1);
    expect(result.identityFactory).toBe(factory);
  });

  it('has a null factory when no plugin binds identity', () => {
    expect(collectRegistrations([plugin('quiet')]).identityFactory).toBeNull();
  });

  it('freezes the hooks object and every hook list', () => {
    const { hooks } = collectRegistrations([
      plugin('p', {
        register(registry) {
          registry.hook('access.check', () => undefined);
        },
      }),
    ]);
    expect(Object.isFrozen(hooks)).toBe(true);
    for (const list of Object.values(hooks)) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });
});

describe('static identity descriptors', () => {
  const entry = { id: 'corp', kind: 'oidc', anchor: 'oidc:https://idp.example.com' };
  const descriptor = { runtimeProviders: false, compiled: [entry] };
  function withDescriptor(value: unknown): PluginDefinition {
    return plugin('sso', {
      binds: ['identity'],
      identityProviders: () => [],
      identityDescriptor: value as never,
    });
  }

  it('accepts an identity descriptor without invoking the factory', () => {
    const definition = {
      ...withDescriptor(descriptor),
      identityProviders: () => {
        throw new Error('must not run');
      },
    };
    expect(collectRegistrations([definition]).identityFactory).toBe(definition.identityProviders);
  });

  it.each([
    ['wrong flag type', { ...descriptor, runtimeProviders: 'true' }],
    ['missing flag', { compiled: [] }],
    [
      '65 entries',
      {
        ...descriptor,
        compiled: Array.from({ length: 65 }, (_, i) => ({
          ...entry,
          id: `p${i}`,
          anchor: `oidc:https://p${i}.example.com`,
        })),
      },
    ],
    ['invalid id', { ...descriptor, compiled: [{ ...entry, id: 'Bad_ID' }] }],
    ['reserved id', { ...descriptor, compiled: [{ ...entry, id: 'local' }] }],
    ['bad kind', { ...descriptor, compiled: [{ ...entry, kind: 'saml' }] }],
    [
      'bad anchor',
      { ...descriptor, compiled: [{ ...entry, anchor: 'oidc:http://public.example.com' }] },
    ],
    [
      'oidc anchor with access kind',
      { ...descriptor, compiled: [{ ...entry, kind: 'cloudflare-access' }] },
    ],
    [
      'access anchor with oidc kind',
      {
        ...descriptor,
        compiled: [{ ...entry, anchor: `access:acme.cloudflareaccess.com/${'a'.repeat(64)}` }],
      },
    ],
    [
      'duplicate id',
      { ...descriptor, compiled: [entry, { ...entry, anchor: 'oidc:https://other.example.com' }] },
    ],
    ['duplicate anchor', { ...descriptor, compiled: [entry, { ...entry, id: 'other' }] }],
    ['extra descriptor field', { ...descriptor, clientId: 'private' }],
    ['extra entry field', { ...descriptor, compiled: [{ ...entry, policy: {} }] }],
    ['null', null],
    ['array', []],
    ['non-array compiled', { ...descriptor, compiled: {} }],
    ['missing compiled', { runtimeProviders: true }],
    ['null entry', { ...descriptor, compiled: [null] }],
    ['sparse compiled', { ...descriptor, compiled: Array(1) }],
    ['non-string id', { ...descriptor, compiled: [{ ...entry, id: 42 }] }],
    ['non-string anchor', { ...descriptor, compiled: [{ ...entry, anchor: 42 }] }],
  ])('rejects %s as a KernelConfigError without exposing descriptor values', (_name, value) => {
    expect(problemsOf([withDescriptor(value)])).toEqual([
      'plugin "sso" identityDescriptor is malformed',
    ]);
  });

  it.each([
    ['oidc:https://IDP.example.com:443/', 'oidc:https://idp.example.com'],
    ['oidc:https://idp.example.com./dex/', 'oidc:https://idp.example.com/dex'],
    ['oidc:https://idp.example.com/%64ex', 'oidc:https://idp.example.com/dex'],
    ['oidc:https://idp.example.com/a%2fb', 'oidc:https://idp.example.com/a%2Fb'],
  ])('rejects duplicate canonical anchors %s and %s', (a, b) => {
    for (const anchor of [a, b]) {
      expect(() =>
        collectRegistrations([
          withDescriptor({
            ...descriptor,
            compiled: [{ ...entry, anchor }],
          }),
        ]),
      ).not.toThrow();
    }
    expect(
      problemsOf([
        withDescriptor({
          ...descriptor,
          compiled: [
            { ...entry, anchor: a },
            { ...entry, id: 'other', anchor: b },
          ],
        }),
      ]),
    ).toEqual(['plugin "sso" identityDescriptor is malformed']);
  });

  it('rejects a descriptor on an unbound plugin', () => {
    expect(problemsOf([plugin('sso', { identityDescriptor: descriptor as never })])).toEqual([
      'plugin "sso" identityDescriptor requires an identity binding',
    ]);
  });

  it('converts unreadable descriptor fields into a configuration error', () => {
    const definition = withDescriptor(descriptor);
    Object.defineProperty(definition, 'identityDescriptor', {
      get() {
        throw new Error('private');
      },
    });
    expect(problemsOf([definition])).toEqual(['plugin "sso" identityDescriptor is malformed']);
  });

  it('accepts descriptors with both kinds, an empty list, and the 64-entry limit', () => {
    for (const compiled of [
      [],
      [
        entry,
        {
          id: 'access',
          kind: 'cloudflare-access',
          anchor: `access:acme.cloudflareaccess.com/${'a'.repeat(64)}`,
        },
      ],
      Array.from({ length: 64 }, (_, i) => ({
        ...entry,
        id: `p${i}`,
        anchor: `oidc:https://p${i}.example.com`,
      })),
    ]) {
      expect(() =>
        collectRegistrations([withDescriptor({ runtimeProviders: true, compiled })]),
      ).not.toThrow();
    }
  });

  it('accepts both bound and unbound plugins without a descriptor', () => {
    expect(collectRegistrations([plugin('legacy')]).identityDescriptor).toBeNull();
    expect(
      collectRegistrations([plugin('legacy', { binds: ['identity'], identityProviders: () => [] })])
        .identityDescriptor,
    ).toBeNull();
  });
});

describe('identity descriptor snapshot boundary', () => {
  const entry = { id: 'corp', kind: 'oidc', anchor: 'oidc:https://idp.example.com' };
  const descriptor = { runtimeProviders: true, compiled: [entry] };
  const malformed = ['plugin "sso" identityDescriptor is malformed'];
  function definition(value: unknown): PluginDefinition {
    return plugin('sso', {
      binds: ['identity'],
      identityProviders: () => [],
      identityDescriptor: value as never,
    });
  }

  it('validates array indices even when an iterator hides malformed entries', () => {
    const compiled = Object.assign([{ bad: 1 }], { [Symbol.iterator]: function* () {} });
    expect(problemsOf([definition({ runtimeProviders: true, compiled })])).toEqual(malformed);
  });

  it('never reads a compiled array iterator', () => {
    const compiled = [{ ...entry }];
    Object.defineProperty(compiled, Symbol.iterator, {
      get() {
        throw new Error('private');
      },
    });
    expect(
      collectRegistrations([definition({ ...descriptor, compiled })]).identityDescriptor,
    ).toEqual(descriptor);
  });

  it('reads every field and array index once and returns the first values as a frozen plain snapshot', () => {
    const counts = new Map<string, number>();
    function changing(target: object, key: string, first: unknown, later: unknown, label = key) {
      Object.defineProperty(target, key, {
        enumerable: true,
        get() {
          const count = counts.get(label) ?? 0;
          counts.set(label, count + 1);
          return count === 0 ? first : later;
        },
      });
    }
    const rawEntry = {};
    changing(rawEntry, 'id', entry.id, 'invalid!');
    changing(rawEntry, 'kind', entry.kind, 'saml');
    changing(rawEntry, 'anchor', entry.anchor, 'private');
    const rawArray = Array(1) as unknown[];
    changing(rawArray, '0', rawEntry, { bad: 1 });
    const compiled = new Proxy(rawArray, {
      get(target, key, receiver) {
        if (key === 'length') {
          const count = counts.get('length') ?? 0;
          counts.set('length', count + 1);
          return count === 0 ? 1 : 65;
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const rawDescriptor = {};
    changing(rawDescriptor, 'runtimeProviders', true, 'wrong');
    changing(rawDescriptor, 'compiled', compiled, []);
    const rawPlugin = definition(undefined);
    changing(rawPlugin, 'identityDescriptor', rawDescriptor, null);
    const snapshot = collectRegistrations([rawPlugin]).identityDescriptor!;
    expect([...counts.entries()].sort()).toEqual(
      ['identityDescriptor', 'runtimeProviders', 'compiled', 'length', '0', 'id', 'kind', 'anchor']
        .map((key) => [key, 1])
        .sort(),
    );
    expect(snapshot).toEqual(descriptor);
    expect(snapshot).not.toBe(rawDescriptor);
    expect(snapshot.compiled).not.toBe(compiled);
    expect(snapshot.compiled[0]).not.toBe(rawEntry);
    expect(Reflect.ownKeys(snapshot)).toEqual(['runtimeProviders', 'compiled']);
    expect(Reflect.ownKeys(snapshot.compiled[0]!)).toEqual(['id', 'kind', 'anchor']);
    for (const object of [snapshot, snapshot.compiled, snapshot.compiled[0]!]) {
      expect(Object.isFrozen(object)).toBe(true);
      for (const key of Object.keys(object)) {
        expect(Object.getOwnPropertyDescriptor(object, key)).toHaveProperty('value');
      }
    }
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(snapshot.compiled[0]!)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(descriptor);
  });

  it('isolates the snapshot from later input mutation', () => {
    const input = { runtimeProviders: true, compiled: [{ ...entry }] };
    const snapshot = collectRegistrations([definition(input)]).identityDescriptor;
    input.runtimeProviders = false;
    input.compiled[0]!.id = 'changed';
    input.compiled.push({ ...entry, id: 'other' });
    expect(snapshot).toEqual(descriptor);
  });

  it.each(['runtimeProviders', 'compiled', 'id', 'kind', 'anchor'])(
    'rejects inherited required property %s',
    (key) => {
      const fields: Record<string, unknown> =
        key === 'runtimeProviders' || key === 'compiled' ? { ...descriptor } : { ...entry };
      const inherited = Object.assign(Object.create({ [key]: fields[key] }) as object, fields);
      Reflect.deleteProperty(inherited, key);
      const value =
        key === 'runtimeProviders' || key === 'compiled'
          ? inherited
          : { ...descriptor, compiled: [inherited] };
      expect(problemsOf([definition(value)])).toEqual(malformed);
    },
  );

  it.each(['runtimeProviders', 'compiled', 'id', 'kind', 'anchor', '0'])(
    'reports throwing getter %s as malformed',
    (key) => {
      const input = { runtimeProviders: true, compiled: [{ ...entry }] };
      const target =
        key === '0'
          ? input.compiled
          : key === 'runtimeProviders' || key === 'compiled'
            ? input
            : input.compiled[0]!;
      Object.defineProperty(target, key, {
        get() {
          throw new Error('private');
        },
      });
      expect(problemsOf([definition(input)])).toEqual(malformed);
    },
  );
});
