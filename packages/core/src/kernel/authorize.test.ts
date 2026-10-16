import { describe, expect, it, vi } from 'vitest';
import {
  ENGINE_PLUGIN,
  EngineTimeoutError,
  INPUT_PLUGIN,
  authorizeRoute,
  denyAllEngine,
} from './authorize.js';
import type { AuthorizationEngine, AuthorizationRequest, DenyLogger } from './authorize.js';
import type { HookErrorHandler } from './access.js';
import { orgContext } from '../db/port.js';
import type { AccessCheckInput, HookMap } from '../plugin.js';

type Handler = HookMap['access.check'];
type AccessHooks = Parameters<typeof authorizeRoute>[2];

const request: AuthorizationRequest = {
  request: new Request('https://broker.test/p/items/42'),
  org: orgContext('org-1'),
  route: { plugin: 'demo', method: 'GET', path: '/p/items/:id', permission: 'package.read' },
  params: { id: '42' },
};

const principal = { kind: 'user', id: 'user-1' } as const;

function engineResolving(value: unknown): AuthorizationEngine {
  return { authorize: () => Promise.resolve(value as never) };
}

function expectMalformedReport(onHookError: ReturnType<typeof vi.fn<HookErrorHandler>>): void {
  expect(onHookError).toHaveBeenCalledOnce();
  const [event] = onHookError.mock.calls[0] ?? [];
  expect(event?.plugin).toBe('core:authorization');
  expect(event?.error).toBeInstanceOf(TypeError);
  expect((event?.error as Error).message).toBe('malformed authorization decision');
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function hook(plugin: string, handler: Handler): { plugin: string; handler: Handler } {
  return { plugin, handler };
}

describe('denyAllEngine', () => {
  it('resolves 403', async () => {
    await expect(denyAllEngine.authorize(request)).resolves.toEqual({ allow: false, status: 403 });
  });
});

describe('authorizeRoute', () => {
  it('denies with 403 under denyAllEngine without calling hooks', async () => {
    const handler = vi.fn<Handler>(() => undefined);

    await expect(authorizeRoute(request, denyAllEngine, [hook('a', handler)])).resolves.toEqual({
      allow: false,
      status: 403,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns the engine principal and projectId when it allows and no hooks exist', async () => {
    const engine = engineResolving({ allow: true, principal, projectId: 'proj-7' });

    await expect(authorizeRoute(request, engine, [])).resolves.toEqual({
      allow: true,
      principal,
      projectId: 'proj-7',
    });
  });

  it('passes the engine decision and the route permission to every hook', async () => {
    const engine = engineResolving({ allow: true, principal, projectId: null });
    const handler = vi.fn<Handler>(() => undefined);

    await expect(authorizeRoute(request, engine, [hook('a', handler)])).resolves.toEqual({
      allow: true,
      principal,
      projectId: null,
    });
    expect(handler).toHaveBeenCalledWith({
      org: request.org,
      principal,
      permission: 'package.read',
      projectId: null,
    } satisfies AccessCheckInput);
  });

  it('gives the engine the request unchanged', async () => {
    const authorize = vi.fn<AuthorizationEngine['authorize']>(() =>
      Promise.resolve({ allow: false, status: 403 }),
    );

    await authorizeRoute(request, { authorize }, []);
    expect(authorize).toHaveBeenCalledWith(request);
  });

  it('denies with 403 when the engine allows and one hook denies', async () => {
    const engine = engineResolving({ allow: true, principal, projectId: 'proj-7' });
    const pass = vi.fn<Handler>(() => undefined);
    const deny = vi.fn<Handler>(() => ({ deny: true, reason: 'blocked by policy' }));

    await expect(
      authorizeRoute(request, engine, [hook('a', pass), hook('b', deny)]),
    ).resolves.toEqual({ allow: false, status: 403 });
    expect(pass).toHaveBeenCalledOnce();
    expect(deny).toHaveBeenCalledOnce();
  });

  it('denies with 403 when a hook throws and reports it', async () => {
    const engine = engineResolving({ allow: true, principal, projectId: null });
    const onHookError = vi.fn<HookErrorHandler>();
    const error = new Error('hook down');

    await expect(
      authorizeRoute(
        request,
        engine,
        [
          hook('a', () => {
            throw error;
          }),
        ],
        onHookError,
      ),
    ).resolves.toEqual({ allow: false, status: 403 });
    expect(onHookError).toHaveBeenCalledWith({ plugin: 'a', error });
  });

  it('passes hookTimeoutMs through to the access checks', async () => {
    vi.useFakeTimers();
    try {
      const engine = engineResolving({ allow: true, principal, projectId: null });
      const pending = authorizeRoute(
        request,
        engine,
        [hook('slow', () => new Promise<undefined>(() => undefined))],
        undefined,
        { hookTimeoutMs: 5 },
      );
      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).resolves.toEqual({ allow: false, status: 403 });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([401, 403] as const)(
    'returns the engine %i deny unchanged without calling hooks',
    async (status) => {
      const handler = vi.fn<Handler>(() => undefined);

      await expect(
        authorizeRoute(request, engineResolving({ allow: false, status }), [hook('a', handler)]),
      ).resolves.toEqual({ allow: false, status });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('denies with 403 and reports core:authorization when the engine rejects', async () => {
    const error = new Error('engine down');
    const onHookError = vi.fn<HookErrorHandler>();
    const handler = vi.fn<Handler>(() => undefined);

    await expect(
      authorizeRoute(
        request,
        { authorize: () => Promise.reject(error) },
        [hook('a', handler)],
        onHookError,
      ),
    ).resolves.toEqual({ allow: false, status: 403 });
    expect(onHookError).toHaveBeenCalledWith({ plugin: 'core:authorization', error });
    expect(handler).not.toHaveBeenCalled();
  });

  it('denies with 403 and reports core:authorization when the engine throws synchronously', async () => {
    const error = new Error('engine broke');
    const onHookError = vi.fn<HookErrorHandler>();
    const engine: AuthorizationEngine = {
      authorize: () => {
        throw error;
      },
    };

    await expect(authorizeRoute(request, engine, [], onHookError)).resolves.toEqual({
      allow: false,
      status: 403,
    });
    expect(onHookError).toHaveBeenCalledWith({ plugin: 'core:authorization', error });
  });

  it('still denies with 403 when onHookError itself throws', async () => {
    const engine: AuthorizationEngine = { authorize: () => Promise.reject(new Error('x')) };
    const onHookError: HookErrorHandler = () => {
      throw new Error('logger down');
    };

    await expect(authorizeRoute(request, engine, [], onHookError)).resolves.toEqual({
      allow: false,
      status: 403,
    });
  });

  it.each([
    ['allow true without principal', { allow: true, projectId: null }],
    ['allow true without projectId', { allow: true, principal }],
    ['principal null', { allow: true, principal: null, projectId: null }],
    [
      'principal with unknown kind',
      { allow: true, principal: { kind: 'admin', id: 'x' }, projectId: null },
    ],
    [
      'principal with empty id',
      { allow: true, principal: { kind: 'user', id: '' }, projectId: null },
    ],
    [
      'principal with numeric id',
      { allow: true, principal: { kind: 'user', id: 7 }, projectId: null },
    ],
    [
      'principal with an extra key',
      { allow: true, principal: { ...principal, admin: true }, projectId: null },
    ],
    ['projectId number', { allow: true, principal, projectId: 7 }],
    ['projectId empty', { allow: true, principal, projectId: '' }],
    ['projectId whitespace', { allow: true, principal, projectId: '  ' }],
    [
      'principal id whitespace',
      { allow: true, principal: { kind: 'user', id: ' \t ' }, projectId: null },
    ],
    [
      'principal id with newline',
      { allow: true, principal: { kind: 'user', id: 'a\nb' }, projectId: null },
    ],
    [
      'principal id with NUL',
      { allow: true, principal: { kind: 'user', id: 'a\u0000' }, projectId: null },
    ],
    [
      'principal id with C1 control',
      { allow: true, principal: { kind: 'user', id: 'a\u0085' }, projectId: null },
    ],
    [
      'principal kind inherited name',
      { allow: true, principal: { kind: 'toString', id: 'x' }, projectId: null },
    ],
    ['allow true with an own then value', { allow: true, principal, projectId: null, then: 1 }],
    ['allow true with status', { allow: true, principal, projectId: null, status: 403 }],
    ['allow "true"', { allow: 'true', principal, projectId: null }],
    ['allow false with status 200', { allow: false, status: 200 }],
    ['allow false with status 500', { allow: false, status: 500 }],
    ['allow false without status', { allow: false }],
    ['allow false with principal', { allow: false, status: 401, principal }],
    ['missing allow', { principal, projectId: null }],
    ['undefined', undefined],
    ['null', null],
    ['a string', 'allow'],
    ['an array', [true]],
  ])('denies with 403 on a malformed decision and reports it: %s', async (_name, value) => {
    const handler = vi.fn<Handler>(() => undefined);
    const onHookError = vi.fn<HookErrorHandler>();

    await expect(
      authorizeRoute(request, engineResolving(value), [hook('a', handler)], onHookError),
    ).resolves.toEqual({ allow: false, status: 403 });
    expect(handler).not.toHaveBeenCalled();
    expectMalformedReport(onHookError);
  });

  it.each(['\u200b', '\u2028', '\u2029'])(
    'rejects invisible identifier character %j in principal and project ids',
    async (character) => {
      for (const decision of [
        { allow: true, principal: { ...principal, id: `user${character}1` }, projectId: null },
        { allow: true, principal, projectId: `project${character}1` },
      ]) {
        const onHookError = vi.fn<HookErrorHandler>();
        const handler = vi.fn<Handler>();
        await expect(
          authorizeRoute(request, engineResolving(decision), [hook('a', handler)], onHookError),
        ).resolves.toEqual({ allow: false, status: 403 });
        expectMalformedReport(onHookError);
        expect(handler).not.toHaveBeenCalled();
      }
    },
  );

  it('denies with 403 when allow is an accessor', async () => {
    const decision = { principal, projectId: null };
    Object.defineProperty(decision, 'allow', { enumerable: true, get: () => true });

    await expect(authorizeRoute(request, engineResolving(decision), [])).resolves.toEqual({
      allow: false,
      status: 403,
    });
  });

  it('returns a copy the engine cannot change after the hooks ran', async () => {
    const mutablePrincipal: { kind: 'user'; id: string } = { kind: 'user', id: 'user-1' };
    const decision = { allow: true, principal: mutablePrincipal, projectId: null };
    const handler = vi.fn<Handler>(() => {
      mutablePrincipal.id = 'admin';
      return undefined;
    });

    const result = await authorizeRoute(request, engineResolving(decision), [hook('a', handler)]);

    expect(result).toEqual({
      allow: true,
      principal: { kind: 'user', id: 'user-1' },
      projectId: null,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('forwards an exact deny with status 404', async () => {
    const onHookError = vi.fn<HookErrorHandler>();

    await expect(
      authorizeRoute(request, engineResolving({ allow: false, status: 404 }), [], onHookError),
    ).resolves.toEqual({ allow: false, status: 404 });
    expect(onHookError).not.toHaveBeenCalled();
  });

  it.each([400, 405, 410, 500])(
    'reports a deny with status %i outside the accepted set as malformed',
    async (status) => {
      const onHookError = vi.fn<HookErrorHandler>();

      await expect(
        authorizeRoute(request, engineResolving({ allow: false, status }), [], onHookError),
      ).resolves.toEqual({ allow: false, status: 403 });
      expectMalformedReport(onHookError);
    },
  );

  it.each([
    ['extra key', { allow: false, status: 404, reason: 'x' }],
    ['string status', { allow: false, status: '404' }],
    ['fractional status', { allow: false, status: 404.5 }],
    ['missing status', { allow: false }],
    ['null prototype', Object.assign(Object.create(null) as object, { allow: false, status: 404 })],
    [
      'class instance',
      new (class Deny {
        allow = false;
        status = 404;
      })(),
    ],
    [
      'accessor status',
      Object.defineProperty({ allow: false }, 'status', { get: () => 404, enumerable: true }),
    ],
    [
      'throwing proxy',
      new Proxy(
        { allow: false, status: 404 },
        {
          getOwnPropertyDescriptor() {
            throw new Error('trap');
          },
        },
      ),
    ],
  ])('reports a malformed 404 (%s) through onHookError and denies 403', async (_name, value) => {
    const onHookError = vi.fn<HookErrorHandler>();

    await expect(authorizeRoute(request, engineResolving(value), [], onHookError)).resolves.toEqual(
      { allow: false, status: 403 },
    );
    expectMalformedReport(onHookError);
  });

  it('keeps a 404 decision when a hook chain is present and never runs the hooks', async () => {
    const handler = vi.fn<Handler>(() => undefined);

    const result = await authorizeRoute(request, engineResolving({ allow: false, status: 404 }), [
      hook('a', handler),
    ]);

    expect(result).toEqual({ allow: false, status: 404 });
    expect(handler).not.toHaveBeenCalled();
  });

  describe('snapshot taken before the engine runs', () => {
    it('hooks judge the original org and permission when the engine mutates the request', async () => {
      const mutable = {
        ...request,
        org: orgContext('org-1'),
        route: { ...request.route },
      };
      const handler = vi.fn<Handler>(() => undefined);
      const engine: AuthorizationEngine = {
        authorize: (seen) => {
          const target = seen as { org: unknown; route: { permission: string } };
          target.route.permission = 'admin.everything';
          target.org = orgContext('org-2');
          return Promise.resolve({ allow: true, principal, projectId: null });
        },
      };

      await authorizeRoute(mutable, engine, [hook('a', handler)]);

      expect(handler).toHaveBeenCalledWith({
        org: orgContext('org-1'),
        principal,
        permission: 'package.read',
        projectId: null,
      });
    });

    it('hooks judge the original route when the caller replaces it while the engine is pending', async () => {
      const mutable: { -readonly [K in keyof AuthorizationRequest]: AuthorizationRequest[K] } = {
        ...request,
      };
      const gate = deferred<{ allow: true; principal: typeof principal; projectId: null }>();
      const handler = vi.fn<Handler>(() => undefined);
      const hooks = [hook('a', handler)];

      const pending = authorizeRoute(mutable, { authorize: () => gate.promise }, hooks);
      mutable.route = { ...request.route, permission: 'admin.everything' };
      mutable.org = orgContext('org-2');
      hooks.push(hook('late', () => ({ deny: true })));
      gate.resolve({ allow: true, principal, projectId: null });

      await expect(pending).resolves.toEqual({ allow: true, principal, projectId: null });
      expect(handler).toHaveBeenCalledWith({
        org: orgContext('org-1'),
        principal,
        permission: 'package.read',
        projectId: null,
      });
    });

    it.each([
      ['non-string permission', () => ({ ...request, route: { ...request.route, permission: 7 } })],
      ['empty permission', () => ({ ...request, route: { ...request.route, permission: '' } })],
      [
        'whitespace-only permission',
        () => ({ ...request, route: { ...request.route, permission: '   ' } }),
      ],
      [
        'permission with a zero-width space',
        () => ({ ...request, route: { ...request.route, permission: 'package\u200bread' } }),
      ],
      [
        'permission with a line separator',
        () => ({ ...request, route: { ...request.route, permission: 'package\u2028read' } }),
      ],
      [
        'unreadable request',
        () =>
          Object.defineProperty({ ...request }, 'org', {
            get() {
              throw new Error('org');
            },
          }),
      ],
    ])('reports %s as input failure before running the engine', async (_name, makeRequest) => {
      const onHookError = vi.fn<HookErrorHandler>();
      const authorize = vi.fn<AuthorizationEngine['authorize']>();
      const handler = vi.fn<Handler>();

      await expect(
        authorizeRoute(
          makeRequest() as AuthorizationRequest,
          { authorize },
          [hook('a', handler)],
          onHookError,
        ),
      ).resolves.toEqual({ allow: false, status: 403 });
      expect(authorize).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(onHookError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ plugin: INPUT_PLUGIN, error: expect.any(Error) }),
      );
    });

    it.each(['hooks', 'engineTimeoutMs', 'hookTimeoutMs', 'onDeny'] as const)(
      'reports a throwing %s getter as an input failure',
      async (property) => {
        const error = new Error('getter');
        const getter = {
          get() {
            throw error;
          },
        };
        const hooks =
          property === 'hooks' ? (Object.defineProperty([], 'map', getter) as AccessHooks) : [];
        const options = property === 'hooks' ? {} : Object.defineProperty({}, property, getter);
        const authorize = vi.fn<AuthorizationEngine['authorize']>();
        const onHookError = vi.fn<HookErrorHandler>();

        await expect(
          authorizeRoute(request, { authorize }, hooks, onHookError, options),
        ).resolves.toEqual({ allow: false, status: 403 });
        expect(authorize).not.toHaveBeenCalled();
        expect(onHookError).toHaveBeenCalledExactlyOnceWith({
          plugin: INPUT_PLUGIN,
          error,
        });
      },
    );
  });

  describe('onDeny', () => {
    const allowEngine = engineResolving({ allow: true, principal, projectId: null });

    it('names the plugin and reason that denied, and the decision carries neither', async () => {
      const onDeny = vi.fn<DenyLogger>();
      const later = vi.fn<Handler>(() => undefined);

      const result = await authorizeRoute(
        request,
        allowEngine,
        [
          hook('a', () => undefined),
          hook('b', () => ({ deny: true, reason: 'blocked by policy' })),
          hook('c', later),
        ],
        undefined,
        { onDeny },
      );

      expect(result).toEqual({ allow: false, status: 403 });
      expect(JSON.stringify(result)).not.toContain('blocked');
      expect(onDeny).toHaveBeenCalledExactlyOnceWith({ plugin: 'b', reason: 'blocked by policy' });
      expect(later).not.toHaveBeenCalled();
    });

    it('reports hook_error for a throwing hook', async () => {
      const onDeny = vi.fn<DenyLogger>();

      await authorizeRoute(
        request,
        allowEngine,
        [
          hook('a', () => {
            throw new Error('down');
          }),
        ],
        undefined,
        { onDeny },
      );

      expect(onDeny).toHaveBeenCalledWith({ plugin: 'a', reason: 'hook_error' });
    });

    it.each([
      [
        'throws',
        () => {
          throw new Error('logger down');
        },
      ],
      ['is not callable', null as unknown as HookErrorHandler],
    ])(
      'still reports hook_error to onDeny when onHookError %s',
      async (_name: string, onHookError: HookErrorHandler) => {
        const onDeny = vi.fn<DenyLogger>();

        await expect(
          authorizeRoute(
            request,
            allowEngine,
            [
              hook('a', () => {
                throw new Error('hook down');
              }),
            ],
            onHookError,
            { onDeny },
          ),
        ).resolves.toEqual({ allow: false, status: 403 });
        expect(onDeny).toHaveBeenCalledExactlyOnceWith({ plugin: 'a', reason: 'hook_error' });
      },
    );

    it.each(['throw', 'reject', 'timeout'] as const)(
      'reports a hook %s once through onHookError without onDeny',
      async (failure) => {
        vi.useFakeTimers();
        try {
          const error = new Error('hook down');
          const onHookError = vi.fn<HookErrorHandler>();
          const onDeny = vi.fn<DenyLogger>();
          const later = vi.fn<Handler>();
          const handler: Handler = () => {
            if (failure === 'throw') throw error;
            if (failure === 'reject') return Promise.reject(error);
            return new Promise<undefined>(() => undefined);
          };
          const pending = authorizeRoute(
            request,
            allowEngine,
            [hook('a', handler), hook('b', later)],
            onHookError,
            { onDeny, hookTimeoutMs: 5 },
          );
          await vi.advanceTimersByTimeAsync(5);
          await expect(pending).resolves.toEqual({ allow: false, status: 403 });
          expect(onHookError).toHaveBeenCalledExactlyOnceWith({
            plugin: 'a',
            error: failure === 'timeout' ? expect.any(Error) : error,
          });
          expect(onDeny).not.toHaveBeenCalled();
          expect(later).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it('is not called when every hook passes', async () => {
      const onDeny = vi.fn<DenyLogger>();

      await expect(
        authorizeRoute(request, allowEngine, [hook('a', () => undefined)], undefined, { onDeny }),
      ).resolves.toEqual({ allow: true, principal, projectId: null });
      expect(onDeny).not.toHaveBeenCalled();
    });

    it.each([
      [
        'throws',
        () => {
          throw new Error('logger down');
        },
      ],
      ['rejects', () => Promise.reject(new Error('logger down'))],
    ])('still denies with 403 when onDeny %s', async (_name, onDeny) => {
      await expect(
        authorizeRoute(request, allowEngine, [hook('a', () => ({ deny: true }))], undefined, {
          onDeny: onDeny as DenyLogger,
        }),
      ).resolves.toEqual({ allow: false, status: 403 });
    });
  });

  describe('engine timeout', () => {
    it('denies with 403 and reports when the engine does not settle in engineTimeoutMs', async () => {
      vi.useFakeTimers();
      try {
        const onHookError = vi.fn<HookErrorHandler>();
        const handler = vi.fn<Handler>(() => undefined);
        const pending = authorizeRoute(
          request,
          { authorize: () => new Promise<never>(() => undefined) },
          [hook('a', handler)],
          onHookError,
          { engineTimeoutMs: 10 },
        );

        await vi.advanceTimersByTimeAsync(10);

        await expect(pending).resolves.toEqual({ allow: false, status: 403 });
        expect(handler).not.toHaveBeenCalled();
        expect(onHookError).toHaveBeenCalledWith({
          plugin: 'core:authorization',
          error: expect.any(EngineTimeoutError) as unknown,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      undefined,
      0,
      -1,
      1.5,
      600_001,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '10',
    ])('falls back to 2000 ms for engineTimeoutMs %s', async (engineTimeoutMs) => {
      vi.useFakeTimers();
      try {
        let settled = false;
        const pending = authorizeRoute(
          request,
          { authorize: () => new Promise<never>(() => undefined) },
          [],
          undefined,
          { engineTimeoutMs: engineTimeoutMs as number },
        ).then((result) => {
          settled = true;
          return result;
        });

        await vi.advanceTimersByTimeAsync(1999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toEqual({ allow: false, status: 403 });
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([1, 600_000])('accepts the timeout boundary %i', async (engineTimeoutMs) => {
      vi.useFakeTimers();
      try {
        let settled = false;
        const pending = authorizeRoute(
          request,
          { authorize: () => new Promise<never>(() => undefined) },
          [],
          undefined,
          { engineTimeoutMs },
        ).then((result) => {
          settled = true;
          return result;
        });

        await vi.advanceTimersByTimeAsync(engineTimeoutMs - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toEqual({ allow: false, status: 403 });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('hostile decision values', () => {
    it('reads a proxy decision once and returns what the hooks judged', async () => {
      const ids = ['user-1', 'admin'];
      const target = { allow: true, principal: { kind: 'user', id: 'user-1' }, projectId: null };
      const principalTarget = target.principal;
      const principalProxy = new Proxy(principalTarget, {
        getOwnPropertyDescriptor(object, key) {
          if (key === 'id') {
            return {
              value: ids.shift() ?? 'admin',
              writable: true,
              enumerable: true,
              configurable: true,
            };
          }
          return Reflect.getOwnPropertyDescriptor(object, key);
        },
        get: (object, key) => (key === 'id' ? 'admin' : Reflect.get(object, key)),
      });
      const decision = new Proxy(
        { ...target, principal: principalProxy },
        { get: (object, key) => (key === 'allow' ? true : Reflect.get(object, key)) },
      );
      const handler = vi.fn<Handler>(() => undefined);

      const result = await authorizeRoute(request, engineResolving(decision), [hook('a', handler)]);

      expect(result).toEqual({
        allow: true,
        principal: { kind: 'user', id: 'user-1' },
        projectId: null,
      });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ principal: { kind: 'user', id: 'user-1' } }),
      );
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('denies with 403 and reports a proxy whose trap throws', async () => {
      const onHookError = vi.fn<HookErrorHandler>();
      const decision = new Proxy(
        { allow: true, principal, projectId: null },
        {
          ownKeys: () => {
            throw new Error('trap');
          },
        },
      );

      await expect(
        authorizeRoute(request, engineResolving(decision), [], onHookError),
      ).resolves.toEqual({ allow: false, status: 403 });
      expectMalformedReport(onHookError);
    });

    it('adopts a thenable engine result like a promise', async () => {
      const engine = {
        authorize: () => ({
          then: (resolve: (value: unknown) => void) => {
            resolve({ allow: false, status: 401 });
          },
        }),
      } as unknown as AuthorizationEngine;

      await expect(authorizeRoute(request, engine, [])).resolves.toEqual({
        allow: false,
        status: 401,
      });
    });

    it('denies with 403 and reports when a thenable then throws', async () => {
      const error = new Error('then broke');
      const onHookError = vi.fn<HookErrorHandler>();
      const engine = {
        authorize: () => ({
          then: () => {
            throw error;
          },
        }),
      } as unknown as AuthorizationEngine;

      await expect(authorizeRoute(request, engine, [], onHookError)).resolves.toEqual({
        allow: false,
        status: 403,
      });
      expect(onHookError).toHaveBeenCalledWith({ plugin: 'core:authorization', error });
    });

    it('denies with 403 when a thenable never settles', async () => {
      vi.useFakeTimers();
      try {
        const engine = {
          authorize: () => ({ then: () => undefined }),
        } as unknown as AuthorizationEngine;
        const pending = authorizeRoute(request, engine, [], undefined, { engineTimeoutMs: 5 });

        await vi.advanceTimersByTimeAsync(5);

        await expect(pending).resolves.toEqual({ allow: false, status: 403 });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('still denies with 403 when onHookError rejects', async () => {
    const onHookError = vi.fn(() => Promise.reject(new Error('logger down')));

    await expect(
      authorizeRoute(
        request,
        { authorize: () => Promise.reject(new Error('x')) },
        [],
        onHookError as unknown as HookErrorHandler,
      ),
    ).resolves.toEqual({ allow: false, status: 403 });
    expect(onHookError).toHaveBeenCalledOnce();
  });
});

describe('verified tokenId', () => {
  const allowWith = (extra: Record<string, unknown>): unknown => ({
    allow: true,
    principal,
    projectId: null,
    ...extra,
  });
  const denied = { allow: false, status: 403 };

  it('exports the engine label', () => {
    expect(ENGINE_PLUGIN).toBe('core:authorization');
  });

  it('omits tokenId from the copy when the engine did not supply the key', async () => {
    const result = await authorizeRoute(request, engineResolving(allowWith({})), []);

    expect(result).toStrictEqual({ allow: true, principal, projectId: null });
    expect(Object.hasOwn(result, 'tokenId')).toBe(false);
  });

  it('carries a valid tokenId in a frozen copy', async () => {
    const result = await authorizeRoute(
      request,
      engineResolving(allowWith({ tokenId: 'tok_01' })),
      [],
    );

    expect(result).toStrictEqual({ allow: true, principal, projectId: null, tokenId: 'tok_01' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('carries a null tokenId as null', async () => {
    const result = await authorizeRoute(request, engineResolving(allowWith({ tokenId: null })), []);

    expect(result).toStrictEqual({ allow: true, principal, projectId: null, tokenId: null });
  });

  it('accepts a 64 character tokenId', async () => {
    const tokenId = 'a'.repeat(64);
    const result = await authorizeRoute(request, engineResolving(allowWith({ tokenId })), []);

    expect(result).toStrictEqual({ allow: true, principal, projectId: null, tokenId });
  });

  it.each([
    ['empty', ''],
    ['65 characters', 'a'.repeat(65)],
    ['a space', 'tok 01'],
    ['a dot', 'tok.01'],
    ['a number', 42],
    ['an object', { id: 'tok_01' }],
    ['undefined', undefined],
  ])('denies with 403 when tokenId is %s', async (_label, tokenId) => {
    const onHookError = vi.fn<HookErrorHandler>();

    await expect(
      authorizeRoute(request, engineResolving(allowWith({ tokenId })), [], onHookError),
    ).resolves.toEqual(denied);
    expectMalformedReport(onHookError);
  });

  it('denies with 403 and reads a getter tokenId at most once', async () => {
    const getter = vi.fn(() => 'tok_01');
    const decision = allowWith({});
    Object.defineProperty(decision, 'tokenId', { enumerable: true, get: getter });

    await expect(authorizeRoute(request, engineResolving(decision), [])).resolves.toEqual(denied);
    expect(getter.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('denies with 403 when tokenId is inherited', async () => {
    const decision = Object.assign(Object.create({ tokenId: 'tok_01' }) as object, allowWith({}));

    await expect(authorizeRoute(request, engineResolving(decision), [])).resolves.toEqual(denied);
  });

  it.each([401, 403, 404])('denies with 403 when a %s decision carries tokenId', async (status) => {
    const decision = { allow: false, status, tokenId: 'tok_01' };

    await expect(authorizeRoute(request, engineResolving(decision), [])).resolves.toEqual(denied);
  });

  it('denies with 403 on any other extra key', async () => {
    await expect(
      authorizeRoute(request, engineResolving(allowWith({ extra: 1 })), []),
    ).resolves.toEqual(denied);
    await expect(
      authorizeRoute(request, engineResolving(allowWith({ tokenId: 'tok_01', extra: 1 })), []),
    ).resolves.toEqual(denied);
  });

  it('keeps tokenId on the decision after the hooks allow', async () => {
    const handler = vi.fn<Handler>(() => undefined);
    const result = await authorizeRoute(
      request,
      engineResolving(allowWith({ tokenId: 'tok_01' })),
      [hook('a', handler)],
    );

    expect(result).toStrictEqual({ allow: true, principal, projectId: null, tokenId: 'tok_01' });
  });
});
