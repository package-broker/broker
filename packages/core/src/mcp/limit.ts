export interface McpRateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface McpLimiter {
  check(selector: string): Promise<boolean>;
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
