import { describe, expect, it, vi } from 'vitest';
import {
  assertMcpRateLimit,
  createInProcessMcpLimiter,
  createMcpLimiter,
  McpRateLimitConfigError,
} from './limit.js';

describe('MCP rate-limit configuration', () => {
  it('requires a binding when MCP is enabled on Workers', () => {
    expect(() =>
      assertMcpRateLimit({ runtime: 'workers', mcpEnabled: true, binding: undefined }),
    ).toThrow(McpRateLimitConfigError);
  });

  it('refuses a binding without a limit method', () => {
    expect(() => assertMcpRateLimit({ runtime: 'workers', mcpEnabled: true, binding: {} })).toThrow(
      McpRateLimitConfigError,
    );
  });

  it('refuses a non-callable limit property with a fixed diagnostic', () => {
    expect(() =>
      assertMcpRateLimit({
        runtime: 'workers',
        mcpEnabled: true,
        binding: { limit: 'private-environment-value' },
      }),
    ).toThrowError(
      expect.objectContaining({
        name: 'McpRateLimitConfigError',
        message: 'MCP on Workers requires the MCP_RATE_LIMIT binding',
      }),
    );
  });

  it('refuses a null binding', () => {
    expect(() =>
      assertMcpRateLimit({ runtime: 'workers', mcpEnabled: true, binding: null }),
    ).toThrow(McpRateLimitConfigError);
  });

  it('accepts a Workers binding with a limit method without calling it', () => {
    const limit = vi.fn();
    expect(() =>
      assertMcpRateLimit({ runtime: 'workers', mcpEnabled: true, binding: { limit } }),
    ).not.toThrow();
    expect(limit).not.toHaveBeenCalled();
  });

  it('allows MCP on Node without a binding', () => {
    expect(() =>
      assertMcpRateLimit({ runtime: 'node', mcpEnabled: true, binding: undefined }),
    ).not.toThrow();
  });

  it('allows Workers without a binding when MCP is disabled', () => {
    expect(() =>
      assertMcpRateLimit({ runtime: 'workers', mcpEnabled: false, binding: undefined }),
    ).not.toThrow();
  });
});

describe('MCP limiter', () => {
  it.each([true, false])('returns binding success %s using only the selector', async (success) => {
    const binding = {
      limit: vi.fn(async function (this: unknown) {
        expect(this).toBe(binding);
        return { success };
      }),
    };
    const limiter = createMcpLimiter(binding);
    expect(await limiter.check('abcdefghij23')).toBe(success);
    expect(binding.limit).toHaveBeenCalledExactlyOnceWith({ key: 'abcdefghij23' });
  });
});

describe('in-process MCP limiter', () => {
  function clock(start = 0) {
    let now = start;
    return { nowMs: () => now, advance: (ms: number) => (now += ms) };
  }

  it('allows the limit per selector and refuses the next call in the same window', async () => {
    const time = clock();
    const limiter = createInProcessMcpLimiter({ limit: 3, periodMs: 1000, nowMs: time.nowMs });
    const results = [];
    for (let index = 0; index < 4; index += 1) results.push(await limiter.check('selector-a'));
    expect(results).toEqual([true, true, true, false]);
    expect(await limiter.check('selector-b')).toBe(true);
    time.advance(999);
    expect(await limiter.check('selector-a')).toBe(false);
    time.advance(1);
    expect(await limiter.check('selector-a')).toBe(true);
  });

  it('defaults to 60 calls per 60 s', async () => {
    const time = clock();
    const limiter = createInProcessMcpLimiter({ nowMs: time.nowMs });
    for (let index = 0; index < 60; index += 1) {
      expect(await limiter.check('selector-a')).toBe(true);
    }
    expect(await limiter.check('selector-a')).toBe(false);
    time.advance(59_999);
    expect(await limiter.check('selector-a')).toBe(false);
    time.advance(1);
    expect(await limiter.check('selector-a')).toBe(true);
  });

  it('times windows on the monotonic clock, so a wall-clock step back neither resets nor extends them', async () => {
    let monotonic = 1_000;
    let wall = 1_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    try {
      const limiter = createInProcessMcpLimiter({ limit: 1, periodMs: 1000 });
      expect(await limiter.check('selector-a')).toBe(true);
      wall -= 3_600_000;
      monotonic += 500;
      expect(await limiter.check('selector-a')).toBe(false);
      expect(limiter.retryAfterSeconds?.('selector-a')).toBe(1);
      wall -= 3_600_000;
      monotonic += 500;
      expect(await limiter.check('selector-a')).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('reports the time left in the refused window, rounded up to whole seconds', async () => {
    const time = clock();
    const limiter = createInProcessMcpLimiter({ limit: 1, periodMs: 60_000, nowMs: time.nowMs });
    expect(await limiter.check('selector-a')).toBe(true);
    time.advance(15_500);
    expect(await limiter.check('selector-a')).toBe(false);
    expect(limiter.retryAfterSeconds?.('selector-a')).toBe(45);
    time.advance(44_999);
    expect(limiter.retryAfterSeconds?.('selector-a')).toBe(1);
  });

  it('reports the oldest live window when a new selector is refused for capacity', async () => {
    const time = clock();
    const limiter = createInProcessMcpLimiter({
      limit: 5,
      periodMs: 10_000,
      maxKeys: 1,
      nowMs: time.nowMs,
    });
    expect(await limiter.check('selector-a')).toBe(true);
    time.advance(3_000);
    expect(await limiter.check('selector-b')).toBe(false);
    expect(limiter.retryAfterSeconds?.('selector-b')).toBe(7);
  });

  it('refuses a new selector while every tracked window is live', async () => {
    const time = clock();
    const limiter = createInProcessMcpLimiter({
      limit: 5,
      periodMs: 1000,
      maxKeys: 2,
      nowMs: time.nowMs,
    });
    expect(await limiter.check('selector-a')).toBe(true);
    expect(await limiter.check('selector-b')).toBe(true);
    expect(await limiter.check('selector-c')).toBe(false);
    expect(await limiter.check('selector-a')).toBe(true);
    time.advance(1000);
    expect(await limiter.check('selector-c')).toBe(true);
  });

  it.each([
    ['limit', { limit: 0 }],
    ['periodMs', { periodMs: 1.5 }],
    ['maxKeys', { maxKeys: -1 }],
  ] as const)('rejects a non-positive or fractional %s', (name, options) => {
    expect(() => createInProcessMcpLimiter(options)).toThrow(
      new TypeError(`${name} must be a positive integer`),
    );
  });
});
