import { apiError, jsonResponse } from '../api/response.js';
import { readJsonBody } from '../api/validate.js';
import { accessContextOf } from '../authz/access-context.js';
import { envelopeResponse } from '../kernel/errors.js';
import type { RouteDefinition } from '../kernel/routes.js';
import type { RequestContext } from '../plugin.js';
import { mcpGate } from './gate.js';
import type { McpLimiter } from './limit.js';

export type McpHandler = (params: unknown, ctx: RequestContext) => Promise<unknown>;

export interface McpOptions {
  readonly handlers: Readonly<Record<string, McpHandler>>;
  readonly publicOrigin: string;
  readonly timeoutMs?: number;
  readonly limiter?: McpLimiter;
}

const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-11-25'];

const ERROR_MESSAGES = {
  '-32700': 'Parse error',
  '-32600': 'Invalid Request',
  '-32601': 'Method not found',
  '-32602': 'Invalid params',
  '-32603': 'Internal error',
} as const;
type ErrorCode = -32700 | -32600 | -32601 | -32602 | -32603;
type RequestId = string | number;

const calls = new WeakMap<
  RequestContext,
  { readonly id: RequestId | null; readonly signal: AbortSignal }
>();

export function mcpCallContextOf(ctx: RequestContext) {
  return calls.get(ctx);
}

export class McpError extends Error {
  readonly code: -32602;

  constructor(code: -32602) {
    super('Invalid params');
    this.name = 'McpError';
    this.code = code;
  }
}

export class McpHttpError extends Error {
  readonly code: 'forbidden' | 'not_found';

  constructor(code: 'forbidden' | 'not_found') {
    super(code === 'forbidden' ? 'Access denied' : 'Not found');
    this.name = 'McpHttpError';
    this.code = code;
  }
}

interface RpcRequest {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly id?: RequestId;
  readonly params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequest(value: unknown): value is RpcRequest {
  return (
    isRecord(value) &&
    value['jsonrpc'] === '2.0' &&
    typeof value['method'] === 'string' &&
    (!Object.hasOwn(value, 'id') ||
      typeof value['id'] === 'string' ||
      (typeof value['id'] === 'number' && Number.isSafeInteger(value['id']))) &&
    (!Object.hasOwn(value, 'params') || isRecord(value['params']) || Array.isArray(value['params']))
  );
}

function rpcError(id: RequestId | null, code: ErrorCode): Response {
  return jsonResponse(200, {
    jsonrpc: '2.0',
    id,
    error: { code, message: ERROR_MESSAGES[code] },
  });
}

async function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('MCP deadline exceeded'));
          controller.abort();
        }, timeoutMs);
      }),
      Promise.resolve().then(() => run(controller.signal)),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function createMcpRoutes(options: McpOptions): readonly RouteDefinition[] {
  const { handlers, publicOrigin } = options;
  const timeoutMs = options.timeoutMs ?? 10000;
  if (publicOrigin === 'null' || publicOrigin !== new URL(publicOrigin).origin) {
    throw new TypeError('publicOrigin must be a canonical origin');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1) {
    throw new TypeError('timeoutMs must be an integer between 1 and 2147483647');
  }

  const post = async (ctx: RequestContext): Promise<Response> => {
    const refusal = mcpGate(ctx, publicOrigin);
    if (refusal !== null) return refusal;

    const protocolVersion = ctx.request.headers.get('MCP-Protocol-Version');
    if (protocolVersion !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
      return apiError('invalid_request', ctx.requestId);
    }

    let id: RequestId | null = null;
    let notification = false;
    try {
      return await withDeadline(async (signal) => {
        if (options.limiter !== undefined) {
          const key = accessContextOf(ctx)?.rateKey;
          if (key?.stage !== 'authenticated' || key.tokenSelector === null) {
            return apiError('forbidden', ctx.requestId);
          }
          const allowed = await options.limiter.check(key.tokenSelector);
          signal.throwIfAborted();
          if (!allowed) {
            const response = envelopeResponse(
              429,
              'rate_limited',
              'Rate limit exceeded',
              ctx.requestId,
            );
            response.headers.set('retry-after', '60');
            return response;
          }
        }
        const request =
          ctx.request.body === null
            ? ctx.request
            : new Request(ctx.request, {
                body: ctx.request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
                  signal,
                }),
                duplex: 'half',
              } as RequestInit);
        const body = await readJsonBody(request);
        signal.throwIfAborted();
        if (!body.ok) {
          if (body.status === 400 && body.detail === 'invalid_json') return rpcError(null, -32700);
          return apiError(body.code, ctx.requestId);
        }
        if (!isRequest(body.value)) return rpcError(null, -32600);
        const message = body.value;
        notification = !Object.hasOwn(message, 'id');
        id = message.id ?? null;
        const handler = Object.hasOwn(handlers, message.method)
          ? handlers[message.method]
          : undefined;
        if (message.method !== 'initialize' && message.method !== 'ping' && handler === undefined) {
          return notification ? new Response(null, { status: 202 }) : rpcError(id, -32601);
        }
        let result: unknown;
        if (message.method === 'initialize') {
          const params = message.params;
          if (
            !isRecord(params) ||
            typeof params['protocolVersion'] !== 'string' ||
            !isRecord(params['capabilities']) ||
            !isRecord(params['clientInfo']) ||
            typeof params['clientInfo']['name'] !== 'string' ||
            typeof params['clientInfo']['version'] !== 'string'
          ) {
            throw new McpError(-32602);
          }
          result = {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: 'package-broker', version: '2.0.0' },
          };
        } else if (message.method === 'ping') result = {};
        else {
          calls.set(ctx, { id, signal });
          try {
            result = await handler!(message.params, ctx);
          } finally {
            calls.delete(ctx);
          }
        }
        return notification
          ? new Response(null, { status: 202 })
          : jsonResponse(200, { jsonrpc: '2.0', id, result: result ?? null });
      }, timeoutMs);
    } catch (error) {
      if (
        error instanceof McpHttpError &&
        (error.code === 'forbidden' || error.code === 'not_found')
      ) {
        return apiError(error.code, ctx.requestId);
      }
      if (notification) return new Response(null, { status: 202 });
      return rpcError(id, error instanceof McpError && error.code === -32602 ? -32602 : -32603);
    }
  };

  return [
    {
      method: 'POST',
      path: '/_pb/mcp',
      boundary: 'authenticated',
      permission: null,
      bearerOnly: true,
      api: { exempt: 'mcp' },
      handler: async (ctx) => {
        const response = await post(ctx);
        response.headers.set('cache-control', 'no-store');
        response.headers.set('x-request-id', ctx.requestId);
        return response;
      },
    },
    {
      method: 'GET',
      path: '/_pb/mcp',
      boundary: 'none',
      permission: null,
      needsOrg: false,
      api: { exempt: 'mcp' },
      handler: (ctx) => {
        const response = envelopeResponse(
          405,
          'method_not_allowed',
          'Method not allowed',
          ctx.requestId,
        );
        response.headers.set('allow', 'POST');
        return response;
      },
    },
  ];
}
