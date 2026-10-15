import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookTimeoutError, reportHookError, runAccessChecks } from './access.js';
import type { HookErrorHandler } from './access.js';
import { orgContext } from '../db/port.js';
import type { AccessCheckInput, HookMap } from '../plugin.js';

type Handler = HookMap['access.check'];

const input: AccessCheckInput = {
  org: orgContext('org-1'),
  principal: { kind: 'user', id: 'user-1' },
  permission: 'package.read',
  projectId: null,
};

function hook(plugin: string, handler: Handler): { plugin: string; handler: Handler } {
  return { plugin, handler };
}

function returning(value: unknown): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: (input: AccessCheckInput) => any = () => value;
  return handler;
}

class DenyResult {
  readonly deny = true;
}

describe('reportHookError', () => {
  it('reports the supplied plugin and error and accepts an absent handler', () => {
    const onHookError = vi.fn<HookErrorHandler>();
    const error = new Error('failure');

    reportHookError(onHookError, 'core:authorize-input', error);
    expect(onHookError).toHaveBeenCalledExactlyOnceWith({ plugin: 'core:authorize-input', error });
    expect(() => reportHookError(undefined, 'core:authorize-input', error)).not.toThrow();
  });

  it.each(['throw', 'reject'] as const)('swallows a reporter %s', async (failure) => {
    const onHookError: HookErrorHandler = () => {
      if (failure === 'throw') throw new Error('logger down');
      return Promise.reject(new Error('logger down'));
    };

    expect(() => reportHookError(onHookError, 'plugin', new Error('failure'))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('runAccessChecks', () => {
  it('returns undefined when there are no hooks', async () => {
    await expect(runAccessChecks([], input)).resolves.toBeUndefined();
  });

  it('returns undefined when every hook returns undefined, sync or async', async () => {
    const first = vi.fn<Handler>(() => undefined);
    const second = vi.fn<Handler>(() => Promise.resolve(undefined));

    await expect(
      runAccessChecks([hook('a', first), hook('b', second)], input),
    ).resolves.toBeUndefined();
    expect(first).toHaveBeenCalledWith(input);
    expect(second).toHaveBeenCalledWith(input);
  });

  it('denies with reason "denied" when the hook gives no reason and stops the chain', async () => {
    const next = vi.fn<Handler>(() => undefined);

    const result = await runAccessChecks(
      [hook('a', () => ({ deny: true })), hook('b', next)],
      input,
    );

    expect(result).toEqual({ deny: true, reason: 'denied' });
    expect(next).not.toHaveBeenCalled();
  });

  it('denies with the hook reason and stops the chain', async () => {
    const next = vi.fn<Handler>(() => undefined);

    const result = await runAccessChecks(
      [
        hook('a', () => undefined),
        hook('b', () => Promise.resolve({ deny: true, reason: 'x' })),
        hook('c', next),
      ],
      input,
    );

    expect(result).toEqual({ deny: true, reason: 'x' });
    expect(next).not.toHaveBeenCalled();
  });

  it('awaits each hook before calling the next', async () => {
    const order: string[] = [];
    const slow: Handler = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('slow');
      return undefined;
    };
    const fast: Handler = () => {
      order.push('fast');
      return undefined;
    };

    await runAccessChecks([hook('a', slow), hook('b', fast)], input);

    expect(order).toEqual(['slow', 'fast']);
  });

  it.each([
    ['null', null],
    ['false', false],
    ['true', true],
    ['a string', 'deny'],
    ['a number', 0],
    ['{ deny: false }', { deny: false }],
    ['{ allow: true }', { allow: true }],
    ['{ deny: true, allow: true }', { deny: true, allow: true }],
    ['{ deny: true, reason: 5 }', { deny: true, reason: 5 }],
    ['{ deny: "true" }', { deny: 'true' }],
    ['{ reason: "x" }', { reason: 'x' }],
    ['{}', {}],
    ['an array', [true]],
    ['a class instance', new DenyResult()],
    ['a null-prototype object', Object.assign(Object.create(null) as object, { deny: true })],
    ['a function', () => undefined],
    ['a symbol-keyed extra property', { deny: true, [Symbol('extra')]: 1 }],
    ['{ deny: true, reason: "x", extra: 1 }', { deny: true, reason: 'x', extra: 1 }],
  ])('denies with invalid_hook_result for %s from an any-typed handler', async (_label, value) => {
    const next = vi.fn<Handler>(() => undefined);

    const result = await runAccessChecks([hook('a', returning(value)), hook('b', next)], input);

    expect(result).toEqual({ deny: true, reason: 'invalid_hook_result' });
    expect(next).not.toHaveBeenCalled();
  });

  it('treats { deny: true, allow: true } from an async any-typed handler as invalid', async () => {
    const result = await runAccessChecks(
      [hook('a', returning(Promise.resolve({ deny: true, allow: true })))],
      input,
    );

    expect(result).toEqual({ deny: true, reason: 'invalid_hook_result' });
  });

  it('rejects an accessor deny property without calling the getter', async () => {
    const getter = vi.fn(() => true);
    const value: object = Object.defineProperty({}, 'deny', { get: getter, enumerable: true });

    const result = await runAccessChecks([hook('a', returning(value))], input);

    expect(result).toEqual({ deny: true, reason: 'invalid_hook_result' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects a proxy whose traps throw as invalid_hook_result', async () => {
    const value = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('trap');
        },
      },
    );

    const result = await runAccessChecks([hook('a', returning(value))], input);

    expect(result).toEqual({ deny: true, reason: 'invalid_hook_result' });
  });

  it('reports a synchronous throw as hook_error with the plugin id and error', async () => {
    const error = new Error('boom');
    const onHookError = vi.fn<HookErrorHandler>();
    const next = vi.fn<Handler>(() => undefined);

    const result = await runAccessChecks(
      [
        hook('a', () => undefined),
        hook('b', () => {
          throw error;
        }),
        hook('c', next),
      ],
      input,
      onHookError,
    );

    expect(result).toEqual({ deny: true, reason: 'hook_error' });
    expect(onHookError).toHaveBeenCalledTimes(1);
    expect(onHookError).toHaveBeenCalledWith({ plugin: 'b', error });
    expect(next).not.toHaveBeenCalled();
  });

  it('reports an async rejection as hook_error with the plugin id and error', async () => {
    const error = new Error('rejected');
    const onHookError = vi.fn<HookErrorHandler>();

    const result = await runAccessChecks(
      [hook('p', () => Promise.reject(error))],
      input,
      onHookError,
    );

    expect(result).toEqual({ deny: true, reason: 'hook_error' });
    expect(onHookError).toHaveBeenCalledWith({ plugin: 'p', error });
  });

  it('returns hook_error without an error handler', async () => {
    const result = await runAccessChecks(
      [
        hook('a', () => {
          throw new Error('boom');
        }),
      ],
      input,
    );

    expect(result).toEqual({ deny: true, reason: 'hook_error' });
  });

  it('keeps hook_error when the error handler itself throws', async () => {
    const onHookError = vi.fn<HookErrorHandler>(() => {
      throw new Error('logger down');
    });

    const result = await runAccessChecks(
      [hook('a', () => Promise.reject(new Error('boom')))],
      input,
      onHookError,
    );

    expect(result).toEqual({ deny: true, reason: 'hook_error' });
    expect(onHookError).toHaveBeenCalledTimes(1);
  });

  it('gives every hook its own frozen copy and never lets a hook mutate the caller input', async () => {
    const callerInput = {
      org: orgContext('org-1'),
      principal: { kind: 'user' as const, id: 'user-1' },
      permission: 'package.read',
      projectId: null,
    };
    const tamper = (target: unknown): void => {
      const writable = target as { permission: string; principal: { id: string } };
      Reflect.set(writable, 'permission', 'admin');
      Reflect.set(writable.principal, 'id', 'root');
    };
    const seen: AccessCheckInput[] = [];
    const mutating: Handler = (received) => {
      tamper(received);
      seen.push(received);
      return undefined;
    };
    const observing: Handler = (received) => {
      seen.push(received);
      return undefined;
    };

    await expect(
      runAccessChecks([hook('a', mutating), hook('b', observing)], callerInput),
    ).resolves.toBeUndefined();

    expect(callerInput.permission).toBe('package.read');
    expect(callerInput.principal.id).toBe('user-1');
    expect(seen[1]?.permission).toBe('package.read');
    expect(seen[1]?.principal.id).toBe('user-1');
    expect(seen[0]).not.toBe(callerInput);
    expect(seen[1]).not.toBe(seen[0]);
    expect(Object.isFrozen(seen[1])).toBe(true);
    expect(Object.isFrozen(seen[1]?.principal)).toBe(true);
    expect(Object.isFrozen(seen[1]?.org)).toBe(true);
  });

  it('runs a snapshot of the hook list so a hook splicing the registry cannot skip a deny', async () => {
    const registry: { plugin: string; handler: Handler }[] = [];
    registry.push(
      hook('splicer', () => {
        registry.splice(1);
        return undefined;
      }),
      hook('denier', () => ({ deny: true, reason: 'blocked' })),
    );

    const result = await runAccessChecks(registry, input);

    expect(result).toEqual({ deny: true, reason: 'blocked' });
  });

  it('swallows an async error handler rejection without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let calls = 0;
      const onHookError: HookErrorHandler = async () => {
        calls += 1;
        await Promise.resolve();
        throw new Error('logger down');
      };

      const result = await runAccessChecks(
        [
          hook('a', () => {
            throw new Error('boom');
          }),
        ],
        input,
        onHookError,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(result).toEqual({ deny: true, reason: 'hook_error' });
      expect(calls).toBe(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('denies a transparent proxy over a deny object with the reason it produces', async () => {
    const value = new Proxy({ deny: true }, {});

    const result = await runAccessChecks([hook('a', returning(value))], input);

    expect(result).toEqual({ deny: true, reason: 'denied' });
  });

  it('never calls then on a returned thenable and treats it as invalid', async () => {
    const then = vi.fn((resolve: (value: unknown) => void) => {
      resolve(undefined);
    });

    const result = await runAccessChecks([hook('a', returning({ then }))], input);

    expect(result).toEqual({ deny: true, reason: 'invalid_hook_result' });
    expect(then).not.toHaveBeenCalled();
  });

  it('never reads a then getter on a returned object and treats it as invalid', async () => {
    const getter = vi.fn(() => (resolve: (value: unknown) => void) => {
      resolve(undefined);
    });
    const value: object = Object.defineProperty({}, 'then', { get: getter, enumerable: true });

    const result = await runAccessChecks([hook('a', returning(value))], input);

    expect(result).toEqual({ deny: true, reason: 'invalid_hook_result' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('treats an inherited then as invalid without calling it', async () => {
    const then = vi.fn();
    const value: object = Object.create({ then }) as object;

    const result = await runAccessChecks([hook('a', returning(value))], input);

    expect(result).toEqual({ deny: true, reason: 'invalid_hook_result' });
    expect(then).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty reason', '', 'denied'],
    ['the reserved hook_error code', 'hook_error', 'denied'],
    ['the reserved invalid_hook_result code', 'invalid_hook_result', 'denied'],
    ['a 200-character reason', 'r'.repeat(200), 'r'.repeat(200)],
    ['a 201-character reason', 'r'.repeat(201), 'r'.repeat(200)],
    ['a reason cut inside a surrogate pair', `${'r'.repeat(199)}\u{1F600}`, 'r'.repeat(199)],
    ['CR and LF', 'line\r\nbreak', 'linebreak'],
    ['NUL, tab and DEL', 'a\u0000b\tc\u007F', 'abc'],
    ['a control-only reason', '\r\n\t', 'denied'],
    ['a whitespace-only reason', '   ', 'denied'],
    ['a reserved code with a control prefix', '\u0000hook_error', 'denied'],
    ['a padded mixed-case reserved code', ' Hook_Error ', 'denied'],
    ['an upper-case reserved code', 'INVALID_HOOK_RESULT', 'denied'],
    ['a reserved code with a trailing newline', 'invalid_hook_result\n', 'denied'],
  ])('sanitizes %s', async (_label, reason, expected) => {
    const result = await runAccessChecks([hook('a', () => ({ deny: true, reason }))], input);

    expect(result).toEqual({ deny: true, reason: expected });
  });

  describe('hook deadline', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('counts a never-settling hook as hook_error after the default 1000 ms', async () => {
      vi.useFakeTimers();
      const onHookError = vi.fn<HookErrorHandler>();
      const next = vi.fn<Handler>(() => undefined);

      const pending = runAccessChecks(
        [hook('stuck', () => new Promise<undefined>(() => undefined)), hook('b', next)],
        input,
        onHookError,
      );
      await vi.advanceTimersByTimeAsync(999);
      expect(onHookError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toEqual({ deny: true, reason: 'hook_error' });
      expect(onHookError).toHaveBeenCalledWith({
        plugin: 'stuck',
        error: expect.objectContaining({ name: 'HookTimeoutError' }) as unknown,
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('honours a custom hookTimeoutMs and clears the timer when the hook settles', async () => {
      vi.useFakeTimers();

      const stuck = runAccessChecks(
        [hook('stuck', () => new Promise<undefined>(() => undefined))],
        input,
        undefined,
        { hookTimeoutMs: 50 },
      );
      await vi.advanceTimersByTimeAsync(50);
      await expect(stuck).resolves.toEqual({ deny: true, reason: 'hook_error' });

      await expect(
        runAccessChecks([hook('quick', () => Promise.resolve(undefined))], input, undefined, {
          hookTimeoutMs: 50,
        }),
      ).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      ['0', 0],
      ['a negative value', -1],
      ['a fraction below 1', 0.5],
      ['a fraction above 1', 1.5],
      ['above the upper bound', 600_001],
      ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['2147483648', 2_147_483_648],
      ['a numeric string', '50' as unknown as number],
    ])('falls back to 1000 ms for hookTimeoutMs %s', async (_label, hookTimeoutMs) => {
      vi.useFakeTimers();
      let settled = false;

      const pending = runAccessChecks(
        [hook('stuck', () => new Promise<undefined>(() => undefined))],
        input,
        undefined,
        { hookTimeoutMs },
      ).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toEqual({ deny: true, reason: 'hook_error' });
    });

    it.each([1, 600_000])('accepts the timeout boundary %i', async (hookTimeoutMs) => {
      vi.useFakeTimers();
      let settled = false;
      const pending = runAccessChecks(
        [hook('stuck', () => new Promise<undefined>(() => undefined))],
        input,
        undefined,
        { hookTimeoutMs },
      ).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(hookTimeoutMs - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ deny: true, reason: 'hook_error' });
      expect(vi.getTimerCount()).toBe(0);
    });

    it('reports the timeout as a HookTimeoutError carrying timeoutMs as an own field', async () => {
      vi.useFakeTimers();
      const errors: unknown[] = [];

      const pending = runAccessChecks(
        [hook('stuck', () => new Promise<undefined>(() => undefined))],
        input,
        ({ error }) => {
          errors.push(error);
        },
        { hookTimeoutMs: 25 },
      );
      await vi.advanceTimersByTimeAsync(25);
      await pending;

      expect(errors[0]).toBeInstanceOf(HookTimeoutError);
      expect(Object.hasOwn(errors[0] as object, 'timeoutMs')).toBe(true);
      expect((errors[0] as HookTimeoutError).timeoutMs).toBe(25);
    });
  });

  describe('input that cannot be snapshotted', () => {
    it('denies a cyclic input with hook_error without calling any hook', async () => {
      const principal: Record<string, unknown> = { kind: 'user', id: 'user-1' };
      principal.self = principal;
      const cyclic = { ...input, principal } as unknown as AccessCheckInput;
      const handler = vi.fn<Handler>(() => undefined);

      await expect(runAccessChecks([hook('a', handler)], cyclic)).resolves.toEqual({
        deny: true,
        reason: 'hook_error',
      });
      expect(handler).not.toHaveBeenCalled();
    });

    it('denies an input with a throwing getter with hook_error', async () => {
      const broken = Object.defineProperty({ ...input }, 'permission', {
        enumerable: true,
        get(): string {
          throw new Error('getter');
        },
      });

      await expect(runAccessChecks([hook('a', () => undefined)], broken)).resolves.toEqual({
        deny: true,
        reason: 'hook_error',
      });
    });

    it('denies even with no hooks when the input cannot be copied', async () => {
      const principal: Record<string, unknown> = { kind: 'user', id: 'user-1' };
      principal.self = principal;
      const cyclic = { ...input, principal } as unknown as AccessCheckInput;

      await expect(runAccessChecks([], cyclic)).resolves.toEqual({
        deny: true,
        reason: 'hook_error',
      });
    });
  });
});
