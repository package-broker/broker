export interface McpRateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface McpLimiter {
  check(selector: string): Promise<boolean>;
  /** Seconds until `selector` may call again, read right after a refused `check`. */
  retryAfterSeconds?(selector: string): number;
}

export class McpRateLimitConfigError extends Error {
  constructor() {
    super('MCP on Workers requires the MCP_RATE_LIMIT binding');
    this.name = 'McpRateLimitConfigError';
  }
}

export function assertMcpRateLimit(options: {
  readonly runtime: 'workers' | 'node';
  readonly mcpEnabled: boolean;
  readonly binding?: unknown;
}): void {
  const { runtime, mcpEnabled, binding } = options;
  if (
    runtime === 'workers' &&
    mcpEnabled &&
    (typeof binding !== 'object' ||
      binding === null ||
      !('limit' in binding) ||
      typeof binding.limit !== 'function')
  ) {
    throw new McpRateLimitConfigError();
  }
}

export function createMcpLimiter(binding: McpRateLimitBinding): McpLimiter {
  return {
    check: async (selector) => (await binding.limit({ key: selector })).success,
  };
}

export interface InProcessMcpLimiterOptions {
  readonly limit?: number;
  readonly periodMs?: number;
  readonly maxKeys?: number;
  readonly nowMs?: () => number;
}

/**
 * A per-process fixed window per token selector, matching the Workers binding's simple limit.
 * The default clock is monotonic so a wall-clock step cannot reset or extend a window.
 */
export function createInProcessMcpLimiter(options: InProcessMcpLimiterOptions = {}): McpLimiter {
  const limit = options.limit ?? 60;
  const periodMs = options.periodMs ?? 60_000;
  const maxKeys = options.maxKeys ?? 10_000;
  const nowMs = options.nowMs ?? (() => performance.now());
  for (const [name, value] of [
    ['limit', limit],
    ['periodMs', periodMs],
    ['maxKeys', maxKeys],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer`);
    }
  }
  const windows = new Map<string, { start: number; count: number }>();

  const prune = (now: number): void => {
    for (const [key, window] of windows) {
      if (now - window.start >= periodMs) windows.delete(key);
    }
  };

  return {
    check: async (selector) => {
      const now = nowMs();
      const window = windows.get(selector);
      if (window !== undefined && now - window.start < periodMs) {
        if (window.count >= limit) return false;
        window.count += 1;
        return true;
      }
      windows.delete(selector);
      if (windows.size >= maxKeys) prune(now);
      if (windows.size >= maxKeys) return false;
      windows.set(selector, { start: now, count: 1 });
      return true;
    },
    retryAfterSeconds: (selector) => {
      const window = windows.get(selector) ?? windows.values().next().value;
      const remainingMs = window === undefined ? periodMs : window.start + periodMs - nowMs();
      return Math.max(1, Math.ceil(remainingMs / 1000));
    },
  };
}
