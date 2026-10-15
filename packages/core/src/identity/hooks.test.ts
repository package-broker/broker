import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMapGroupsHooks, runResolveIdentityHooks } from './hooks.js';
import type { HookErrorHandler } from '../kernel/access.js';
import { orgContext } from '../db/port.js';
import type { HookMap } from '../plugin.js';
import type { Registration } from '../kernel/registry.js';

type ResolveHandler = HookMap['auth.resolveIdentity'];
type MapHandler = HookMap['auth.mapGroups'];
type ResolveInput = Parameters<ResolveHandler>[0];
type MapInput = Parameters<MapHandler>[0];

const resolveInput: ResolveInput = {
  org: orgContext('org-1'),
  identity: {
    provider: 'oidc-main',
    subject: 'subject-1',
    email: 'alice@example.com',
    emailVerified: true,
    displayName: null,
    groups: ['a'],
    issuedAt: '2026-10-15T08:00:00.000Z',
    authTime: null,
  },
  userId: null,
};

const mapInput: MapInput = {
  org: orgContext('org-1'),
  provider: 'oidc-main',
  groups: ['a', 'b'],
};

type ResolveHook = Registration['hooks']['auth.resolveIdentity'][number];
type MapHook = Registration['hooks']['auth.mapGroups'][number];

function resolving(plugin: string, value: unknown): ResolveHook {
  const handler = (() => value) as unknown as ResolveHandler;
  return { plugin, handler };
}

function mapping(plugin: string, value: unknown): MapHook {
  const handler = (() => value) as unknown as MapHandler;
  return { plugin, handler };
}

function cyclic(): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  value['self'] = value;
  return value;
}

describe('runResolveIdentityHooks', () => {
  it('returns undefined with no hooks and when every hook passes', async () => {
    await expect(runResolveIdentityHooks([], resolveInput)).resolves.toBeUndefined();
    await expect(
      runResolveIdentityHooks(
        [resolving('a', undefined), resolving('b', Promise.resolve(undefined))],
        resolveInput,
      ),
    ).resolves.toBeUndefined();
  });

  it('drops the free-text reason and exposes only the plugin and a fixed code', async () => {
    const result = await runResolveIdentityHooks(
      [resolving('guard', { deny: true, reason: 'alice@example.com' })],
      resolveInput,
    );
    expect(result).toEqual({ deny: true, plugin: 'guard', code: 'denied' });
    expect(JSON.stringify(result)).not.toContain('alice');
  });

  it('denies with code denied when the hook gives no reason and stops the chain', async () => {
    const next = vi.fn<ResolveHandler>(() => undefined);
    const result = await runResolveIdentityHooks(
      [resolving('guard', { deny: true }), { plugin: 'later', handler: next }],
      resolveInput,
    );
    expect(result).toEqual({ deny: true, plugin: 'guard', code: 'denied' });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ['deny together with allow', { deny: true, allow: true }],
    ['a deny of false', { deny: false }],
    ['a bare string', 'denied'],
    ['an array', [{ deny: true }]],
    ['an empty object', {}],
  ])('treats %s as invalid_hook_result', async (_label, value) => {
    await expect(runResolveIdentityHooks([resolving('p', value)], resolveInput)).resolves.toEqual({
      deny: true,
      plugin: 'p',
      code: 'invalid_hook_result',
    });
  });

  it('rejects an accessor deny property without calling the getter', async () => {
    const getter = vi.fn(() => true);
    const result = Object.defineProperty({}, 'deny', { get: getter, enumerable: true });
    await expect(runResolveIdentityHooks([resolving('p', result)], resolveInput)).resolves.toEqual({
      deny: true,
      plugin: 'p',
      code: 'invalid_hook_result',
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it('turns a throw into hook_error and reports the plugin and error', async () => {
    const onHookError = vi.fn<HookErrorHandler>();
    const error = new Error('boom');
    const thrower: ResolveHandler = () => {
      throw error;
    };
    await expect(
      runResolveIdentityHooks([{ plugin: 'bad', handler: thrower }], resolveInput, onHookError),
    ).resolves.toEqual({ deny: true, plugin: 'bad', code: 'hook_error' });
    expect(onHookError).toHaveBeenCalledExactlyOnceWith({ plugin: 'bad', error });
  });

  it('turns a rejection into hook_error and reports it', async () => {
    const onHookError = vi.fn<HookErrorHandler>();
    const error = new Error('rejected');
    const rejecting: ResolveHandler = () => Promise.reject(error);
    await expect(
      runResolveIdentityHooks([{ plugin: 'bad', handler: rejecting }], resolveInput, onHookError),
    ).resolves.toEqual({ deny: true, plugin: 'bad', code: 'hook_error' });
    expect(onHookError).toHaveBeenCalledExactlyOnceWith({ plugin: 'bad', error });
  });

  it('gives each hook a frozen copy of the input', async () => {
    let seen: ResolveInput | undefined;
    const spy: ResolveHandler = (value) => {
      seen = value;
      return undefined;
    };
    await runResolveIdentityHooks([{ plugin: 'spy', handler: spy }], resolveInput);
    expect(seen).toEqual(resolveInput);
    expect(seen).not.toBe(resolveInput);
    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen?.identity)).toBe(true);
  });

  it('denies an input that cannot be copied as hook_error attributed to core', async () => {
    const next = vi.fn<ResolveHandler>(() => undefined);
    const bad = { ...resolveInput, org: cyclic() as unknown as ResolveInput['org'] };
    await expect(runResolveIdentityHooks([{ plugin: 'p', handler: next }], bad)).resolves.toEqual({
      deny: true,
      plugin: 'core',
      code: 'hook_error',
    });
    await expect(runResolveIdentityHooks([], bad)).resolves.toEqual({
      deny: true,
      plugin: 'core',
      code: 'hook_error',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('does not call onHookError for a denial or an invalid result', async () => {
    const onHookError = vi.fn<HookErrorHandler>();
    await runResolveIdentityHooks([resolving('p', { deny: true })], resolveInput, onHookError);
    await runResolveIdentityHooks(
      [resolving('p', { deny: true, allow: true })],
      resolveInput,
      onHookError,
    );
    expect(onHookError).not.toHaveBeenCalled();
  });

  it('keeps a hook that mutates its input from affecting the next hook', async () => {
    const mutator: ResolveHandler = (value) => {
      try {
        (value.identity as { email: string }).email = 'mallory@example.com';
        (value as { userId: string | null }).userId = 'user-9';
      } catch {
        return undefined;
      }
      return undefined;
    };
    let seen: ResolveInput | undefined;
    const spy: ResolveHandler = (value) => {
      seen = value;
      return undefined;
    };
    await expect(
      runResolveIdentityHooks(
        [
          { plugin: 'mutator', handler: mutator },
          { plugin: 'spy', handler: spy },
        ],
        resolveInput,
      ),
    ).resolves.toBeUndefined();
    expect(seen).toEqual(resolveInput);
    expect(resolveInput.identity.email).toBe('alice@example.com');
  });

  describe('hook deadline', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('denies a hook that never settles with hook_error after hookTimeoutMs', async () => {
      vi.useFakeTimers();
      const onHookError = vi.fn<HookErrorHandler>();
      const stuck: ResolveHandler = () => new Promise<undefined>(() => undefined);
      const pending = runResolveIdentityHooks(
        [{ plugin: 'stuck', handler: stuck }],
        resolveInput,
        onHookError,
        {
          hookTimeoutMs: 50,
        },
      );
      await vi.advanceTimersByTimeAsync(49);
      expect(onHookError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ deny: true, plugin: 'stuck', code: 'hook_error' });
      expect(onHookError).toHaveBeenCalledWith({
        plugin: 'stuck',
        error: expect.objectContaining({ name: 'HookTimeoutError' }) as unknown,
      });
    });
  });
});

describe('runMapGroupsHooks', () => {
  it('returns the input groups with no hooks and when a hook returns undefined', async () => {
    await expect(runMapGroupsHooks([], mapInput)).resolves.toEqual({ groups: ['a', 'b'] });
    await expect(runMapGroupsHooks([mapping('p', undefined)], mapInput)).resolves.toEqual({
      groups: ['a', 'b'],
    });
  });

  it('narrows to the kept subset', async () => {
    await expect(runMapGroupsHooks([mapping('p', { keep: ['a'] })], mapInput)).resolves.toEqual({
      groups: ['a'],
    });
    await expect(runMapGroupsHooks([mapping('p', { keep: [] })], mapInput)).resolves.toEqual({
      groups: [],
    });
  });

  it('keeps input order and removes duplicates', async () => {
    await expect(
      runMapGroupsHooks([mapping('p', { keep: ['b', 'a'] })], mapInput),
    ).resolves.toEqual({ groups: ['a', 'b'] });
    await expect(
      runMapGroupsHooks([mapping('p', { keep: ['a', 'a'] })], mapInput),
    ).resolves.toEqual({ groups: ['a'] });
  });

  it('denies a keep list longer than the current list, reading each entry once', async () => {
    const reads = vi.fn();
    const keep = new Proxy(['a', 'a', 'a'], {
      getOwnPropertyDescriptor(target, key) {
        reads(key);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    await expect(runMapGroupsHooks([mapping('p', { keep })], mapInput)).resolves.toEqual({
      deny: true,
      plugin: 'p',
      code: 'invalid_hook_result',
    });
    expect(reads.mock.calls.filter(([key]) => key !== 'length')).toHaveLength(3);
  });

  it('copies a keep array by its real length when a get trap lies about it', async () => {
    const keep = new Proxy(['a', 'c'], {
      get: (target, key) => (key === 'length' ? 1 : Reflect.get(target, key)),
    });
    await expect(runMapGroupsHooks([mapping('p', { keep })], mapInput)).resolves.toEqual({
      deny: true,
      plugin: 'p',
      code: 'invalid_hook_result',
    });
  });

  it('denies a keep array with an accessor property, index or not, without invoking it', async () => {
    const extra = vi.fn(() => 'x');
    const indexed = vi.fn(() => 'a');
    const withExtra = Object.defineProperty(['a'], 'extra', { get: extra, enumerable: true });
    const withIndex = Object.defineProperty([''], '0', { get: indexed, enumerable: true });
    for (const keep of [withExtra, withIndex]) {
      await expect(runMapGroupsHooks([mapping('p', { keep })], mapInput)).resolves.toEqual({
        deny: true,
        plugin: 'p',
        code: 'invalid_hook_result',
      });
    }
    expect(extra).not.toHaveBeenCalled();
    expect(indexed).not.toHaveBeenCalled();
  });

  it('reads each keep entry from the hook result exactly once', async () => {
    const reads = new Map<string, number>();
    const keep = new Proxy(['b', 'a'], {
      getOwnPropertyDescriptor(target, key) {
        const name = String(key);
        reads.set(name, (reads.get(name) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    await expect(runMapGroupsHooks([mapping('p', { keep })], mapInput)).resolves.toEqual({
      groups: ['a', 'b'],
    });
    expect(reads.get('0')).toBe(1);
    expect(reads.get('1')).toBe(1);
  });

  it.each([
    ['duplicates', ['a', 'a']],
    ['a non-string entry', ['a', 1]],
    ['a hole', new Array<string>(2)],
  ])('denies a starting list with %s as invalid_input and runs no hook', async (_label, groups) => {
    const next = vi.fn<MapHandler>(() => undefined);
    const onHookError = vi.fn<HookErrorHandler>();
    await expect(
      runMapGroupsHooks(
        [{ plugin: 'p', handler: next }],
        { ...mapInput, groups: groups as readonly string[] },
        onHookError,
      ),
    ).resolves.toEqual({ deny: true, plugin: 'core', code: 'invalid_input' });
    expect(next).not.toHaveBeenCalled();
    expect(onHookError).not.toHaveBeenCalled();
  });

  it('copies starting groups without running a custom iterator', async () => {
    class Groups extends Array<string> {
      override [Symbol.iterator](): ArrayIterator<string> {
        return ['a', 'b', 'c'][Symbol.iterator]();
      }
    }
    const groups = Groups.from(['a', 'b']);
    Object.setPrototypeOf(groups, Groups.prototype);
    await expect(runMapGroupsHooks([], { ...mapInput, groups })).resolves.toEqual({
      groups: ['a', 'b'],
    });
    let seen: readonly string[] | undefined;
    const spy: MapHandler = (value) => {
      seen = value.groups;
      return undefined;
    };
    await runMapGroupsHooks([{ plugin: 'spy', handler: spy }], { ...mapInput, groups });
    expect(seen).toEqual(['a', 'b']);
  });

  it('does not run a throwing iterator on the starting groups', async () => {
    const groups = Object.defineProperty(['a', 'b'], Symbol.iterator, {
      value: () => {
        throw new Error('iterator');
      },
    });
    await expect(
      runMapGroupsHooks([mapping('p', undefined)], { ...mapInput, groups }),
    ).resolves.toEqual({ groups: ['a', 'b'] });
  });

  it('denies hook_error attributed to core when a proxy groups array throws', async () => {
    const groups = new Proxy(['a'], {
      getOwnPropertyDescriptor() {
        throw new Error('trap');
      },
    });
    await expect(
      runMapGroupsHooks([mapping('p', undefined)], { ...mapInput, groups }),
    ).resolves.toEqual({ deny: true, plugin: 'core', code: 'hook_error' });
  });

  it('denies starting groups that are not an array as invalid_input', async () => {
    const groups = { length: 1, 0: 'a' } as unknown as readonly string[];
    await expect(
      runMapGroupsHooks([mapping('p', undefined)], { ...mapInput, groups }),
    ).resolves.toEqual({ deny: true, plugin: 'core', code: 'invalid_input' });
  });

  it('denies an input that cannot be copied as hook_error attributed to core, even with no hooks', async () => {
    const next = vi.fn<MapHandler>(() => undefined);
    const onHookError = vi.fn<HookErrorHandler>();
    const throwing = Object.defineProperty({ ...mapInput }, 'provider', {
      get() {
        throw new Error('getter');
      },
      enumerable: true,
    });
    const expected = { deny: true, plugin: 'core', code: 'hook_error' };
    await expect(
      runMapGroupsHooks([{ plugin: 'p', handler: next }], throwing, onHookError),
    ).resolves.toEqual(expected);
    await expect(runMapGroupsHooks([], throwing, onHookError)).resolves.toEqual(expected);
    await expect(
      runMapGroupsHooks([], { ...mapInput, org: cyclic() as unknown as MapInput['org'] }),
    ).resolves.toEqual(expected);
    expect(next).not.toHaveBeenCalled();
    expect(onHookError).not.toHaveBeenCalled();
  });

  it('denies hook_error attributed to core when reading the options throws', async () => {
    const next = vi.fn<MapHandler>(() => undefined);
    const options = Object.defineProperty({}, 'hookTimeoutMs', {
      get() {
        throw new Error('getter');
      },
    });
    await expect(
      runMapGroupsHooks([{ plugin: 'p', handler: next }], mapInput, undefined, options),
    ).resolves.toEqual({ deny: true, plugin: 'core', code: 'hook_error' });
    expect(next).not.toHaveBeenCalled();
  });

  it('is unaffected by the caller changing the input while a hook is pending', async () => {
    const groups = ['a', 'b'];
    const seen: Array<readonly string[]> = [];
    let release: () => void = () => undefined;
    const slow: MapHandler = () =>
      new Promise<undefined>((resolve) => {
        release = () => {
          resolve(undefined);
        };
      });
    const next: MapHandler = (value) => {
      seen.push(value.groups);
      return undefined;
    };
    const pending = runMapGroupsHooks(
      [
        { plugin: 'slow', handler: slow },
        { plugin: 'next', handler: next },
      ],
      { ...mapInput, groups },
    );
    groups.push('c');
    groups[0] = 'z';
    release();
    await expect(pending).resolves.toEqual({ groups: ['a', 'b'] });
    expect(seen).toEqual([['a', 'b']]);
  });

  it('does not call onHookError for an invalid result', async () => {
    const onHookError = vi.fn<HookErrorHandler>();
    await expect(
      runMapGroupsHooks([mapping('p', { keep: 'a' })], mapInput, onHookError),
    ).resolves.toEqual({ deny: true, plugin: 'p', code: 'invalid_hook_result' });
    expect(onHookError).not.toHaveBeenCalled();
  });

  it('accepts a Promise result', async () => {
    const handler: MapHandler = () => Promise.resolve({ keep: ['b'] });
    await expect(runMapGroupsHooks([{ plugin: 'p', handler }], mapInput)).resolves.toEqual({
      groups: ['b'],
    });
  });

  it.each([
    ['a group outside the list', { keep: ['c'] }],
    ['an extra add key', { keep: ['a'], add: ['c'] }],
    ['a string keep', { keep: 'a' }],
    ['a non-string element', { keep: [1] }],
    ['a hole in keep', { keep: new Array<string>(1) }],
    ['a missing keep', {}],
    ['an array result', ['a']],
    ['a bare string', 'a'],
    ['null', null],
    [
      'an object with a null prototype',
      Object.assign(Object.create(null) as object, { keep: ['a'] }),
    ],
    ['an object with an inherited keep', Object.create({ keep: ['a'] }) as object],
    ['a symbol key beside keep', { keep: ['a'], [Symbol('x')]: 1 }],
    ['a deny result', { deny: true }],
  ])('denies %s as invalid_hook_result', async (_label, value) => {
    await expect(runMapGroupsHooks([mapping('p', value)], mapInput)).resolves.toEqual({
      deny: true,
      plugin: 'p',
      code: 'invalid_hook_result',
    });
  });

  it('denies a getter keep without invoking it', async () => {
    const getter = vi.fn(() => ['a']);
    const result = Object.defineProperty({}, 'keep', { get: getter, enumerable: true });
    await expect(runMapGroupsHooks([mapping('p', result)], mapInput)).resolves.toEqual({
      deny: true,
      plugin: 'p',
      code: 'invalid_hook_result',
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it('denies a keep array holding an accessor element without invoking it', async () => {
    const getter = vi.fn(() => 'a');
    const keep = Object.defineProperty(['x'], '0', { get: getter, enumerable: true });
    await expect(runMapGroupsHooks([mapping('p', { keep })], mapInput)).resolves.toEqual({
      deny: true,
      plugin: 'p',
      code: 'invalid_hook_result',
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it('denies a proxy whose traps throw as invalid_hook_result', async () => {
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('trap');
        },
        ownKeys() {
          throw new Error('trap');
        },
      },
    );
    await expect(runMapGroupsHooks([mapping('p', proxy)], mapInput)).resolves.toEqual({
      deny: true,
      plugin: 'p',
      code: 'invalid_hook_result',
    });
  });

  it('never calls then on a returned thenable', async () => {
    const then = vi.fn();
    await expect(
      runMapGroupsHooks([mapping('p', { keep: ['a'], then })], mapInput),
    ).resolves.toEqual({ deny: true, plugin: 'p', code: 'invalid_hook_result' });
    expect(then).not.toHaveBeenCalled();
  });

  it('chains hooks so each sees the previous result', async () => {
    const seen: Array<readonly string[]> = [];
    const second: MapHandler = (value) => {
      seen.push(value.groups);
      return { keep: ['a'] };
    };
    const third: MapHandler = (value) => {
      seen.push(value.groups);
      return undefined;
    };
    const result = await runMapGroupsHooks(
      [
        mapping('first', { keep: ['a', 'b'] }),
        { plugin: 'second', handler: second },
        { plugin: 'third', handler: third },
      ],
      { ...mapInput, groups: ['a', 'b', 'c'] },
    );
    expect(result).toEqual({ groups: ['a'] });
    expect(seen).toEqual([['a', 'b'], ['a']]);
  });

  it('cannot widen across a chain: a later hook may not keep a group an earlier hook dropped', async () => {
    await expect(
      runMapGroupsHooks(
        [mapping('first', { keep: ['a'] }), mapping('second', { keep: ['a', 'b'] })],
        mapInput,
      ),
    ).resolves.toEqual({ deny: true, plugin: 'second', code: 'invalid_hook_result' });
  });

  it('stops at the first denial', async () => {
    const next = vi.fn<MapHandler>(() => undefined);
    await expect(
      runMapGroupsHooks([mapping('bad', 'x'), { plugin: 'later', handler: next }], mapInput),
    ).resolves.toEqual({ deny: true, plugin: 'bad', code: 'invalid_hook_result' });
    expect(next).not.toHaveBeenCalled();
  });

  it('turns a throw and a rejection into hook_error and reports them', async () => {
    const onHookError = vi.fn<HookErrorHandler>();
    const error = new Error('boom');
    const thrower: MapHandler = () => {
      throw error;
    };
    const rejecting: MapHandler = () => Promise.reject(error);
    await expect(
      runMapGroupsHooks([{ plugin: 'bad', handler: thrower }], mapInput, onHookError),
    ).resolves.toEqual({ deny: true, plugin: 'bad', code: 'hook_error' });
    await expect(
      runMapGroupsHooks([{ plugin: 'worse', handler: rejecting }], mapInput, onHookError),
    ).resolves.toEqual({ deny: true, plugin: 'worse', code: 'hook_error' });
    expect(onHookError).toHaveBeenCalledTimes(2);
    expect(onHookError).toHaveBeenNthCalledWith(1, { plugin: 'bad', error });
    expect(onHookError).toHaveBeenNthCalledWith(2, { plugin: 'worse', error });
  });

  it('gives each hook a frozen groups array and never lets it change the caller list', async () => {
    const groups = ['a', 'b'];
    const mutator: MapHandler = (value) => {
      expect(Object.isFrozen(value.groups)).toBe(true);
      expect(() => (value.groups as string[]).push('c')).toThrow(TypeError);
      return undefined;
    };
    const result = await runMapGroupsHooks([{ plugin: 'm', handler: mutator }], {
      ...mapInput,
      groups,
    });
    expect(result).toEqual({ groups: ['a', 'b'] });
    expect(groups).toEqual(['a', 'b']);
    expect(result).toHaveProperty('groups');
    expect(Object.isFrozen((result as { groups: readonly string[] }).groups)).toBe(true);
  });

  describe('hook deadline', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('denies a hook that never settles with hook_error after hookTimeoutMs', async () => {
      vi.useFakeTimers();
      const onHookError = vi.fn<HookErrorHandler>();
      const stuck: MapHandler = () => new Promise<undefined>(() => undefined);
      const pending = runMapGroupsHooks(
        [{ plugin: 'stuck', handler: stuck }],
        mapInput,
        onHookError,
        {
          hookTimeoutMs: 20,
        },
      );
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(19);
      expect(settled).toBe(false);
      expect(onHookError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ deny: true, plugin: 'stuck', code: 'hook_error' });
      expect(onHookError).toHaveBeenCalledWith({
        plugin: 'stuck',
        error: expect.objectContaining({ name: 'HookTimeoutError' }) as unknown,
      });
    });

    it('uses the default 1000 ms deadline when the option is invalid', async () => {
      vi.useFakeTimers();
      const stuck: MapHandler = () => new Promise<undefined>(() => undefined);
      const pending = runMapGroupsHooks(
        [{ plugin: 'stuck', handler: stuck }],
        mapInput,
        undefined,
        {
          hookTimeoutMs: 0,
        },
      );
      await vi.advanceTimersByTimeAsync(999);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ deny: true, plugin: 'stuck', code: 'hook_error' });
    });
  });
});
