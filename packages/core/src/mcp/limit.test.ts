import { describe, expect, it, vi } from 'vitest';
import { assertMcpRateLimit, createMcpLimiter, McpRateLimitConfigError } from './limit.js';

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
