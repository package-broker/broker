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
