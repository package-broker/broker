import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthorizationEngine, patValidationGate } from '../authz/engine.js';
import type { AuthorizationEngine } from '../kernel/authorize.js';
import { createKernel } from '../kernel/kernel.js';
import { createKeyring } from '../secrets/keyring.js';
import { hashToken } from '../secrets/token-hash.js';
import { orgContext } from '../db/port.js';
import {
  accessContextOf,
  setAccessContext,
  type AccessContextSnapshot,
} from '../authz/access-context.js';
import { routeApiProblems, routeBoundaryProblems } from '../kernel/routes.js';
import type { Principal, RequestContext } from '../plugin.js';
import { formatToken } from '../secrets/token-format.js';
import { createMcpRoutes, McpError, McpHttpError, type McpHandler } from './transport.js';

const ORIGIN = 'https://broker.test';
const token = (kind: 'pat' | 'svc' | 'cst' = 'pat') =>
  formatToken(kind, 'abcdefghij23', new Uint8Array(32));
const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
const toolCall = { ...ping, method: 'tools/list' };
const forbidden = { error: { code: 'forbidden', message: 'Access denied', requestId: 'req-1' } };
const unauthorized = {
  error: { code: 'unauthorized', message: 'Unauthorized', requestId: 'req-1' },
};

interface Options {
  headers?: Record<string, string>;
  scope?: 'read' | 'write' | 'full' | null;
  principal?: Principal;
  snapshot?: boolean;
  session?: boolean;
  noToken?: boolean;
  method?: 'GET' | 'POST';
}

function context(body: unknown = ping, options: Options = {}): RequestContext {
  const principal = options.principal ?? { kind: 'user', id: 'user-1' };
  const kind: 'svc' | 'pat' = principal.kind === 'service' ? 'svc' : 'pat';
  const ctx: RequestContext = {
    request: new Request(`${ORIGIN}/_pb/mcp`, {
      method: options.method ?? 'POST',
      headers: {
        authorization: `Bearer ${token(kind)}`,
        'content-type': 'application/json',
        ...options.headers,
      },
      ...(options.method === 'GET'
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
    requestId: 'req-1',
    org: orgContext('org-a'),
    principal,
    projectId: null,
    params: {},
    ports: {
      organizations: { get: async () => null },
      clock: { now: () => new Date(0) },
      ids: { ulid: () => 'id' },
    } as unknown as RequestContext['ports'],
  };
  if (options.headers?.['authorization'] === '') ctx.request.headers.delete('authorization');
  if (options.snapshot !== false) {
    const sessionId = options.session ? 'session-1' : null;
    const metadata =
      options.session || options.noToken
        ? null
        : {
            kind,
            scope: options.scope === undefined ? ('read' as const) : options.scope,
            readOnly: true,
          };
    setAccessContext(ctx, {
      principal,
      projectId: null,
      boundary: 'authenticated',
      sessionId,
      token: metadata,
      actor: null,
      rateKey: {
        stage: 'authenticated',
        principalId: principal.id,
        tokenSelector: metadata === null ? null : 'abcdefghij23',
        routeClass: 'authenticated',
      },
    } satisfies AccessContextSnapshot);
  }
  return ctx;
}

function fixture(handlers: Record<string, McpHandler> = {}, timeoutMs?: number) {
  const routes = createMcpRoutes({
    handlers,
    publicOrigin: ORIGIN,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return {
    routes,
    post: (ctx: RequestContext) =>
      Promise.resolve(routes.find((r) => r.method === 'POST')!.handler(ctx)),
    get: (ctx: RequestContext) =>
      Promise.resolve(routes.find((r) => r.method === 'GET')!.handler(ctx)),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function mounted(
  scope: 'read' | 'write' | 'full' | null = 'read',
  override?: AuthorizationEngine,
  kind: 'pat' | 'svc' = 'pat',
) {
  const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32) }]);
  const verifier = { secretHash: await hashToken(keyring, 1, token(kind)), pepperVersion: 1 };
  const lookupToken = vi.fn(async () => ({
    token: {
      id: 'token-1',
      kind,
      expired: false,
      revoked: false,
      lastUsedAt: null,
      userId: kind === 'pat' ? 'user-1' : null,
      servicePrincipalId: kind === 'svc' ? 'svc-1' : null,
      bindingOk: true,
      projectMode: 'all' as const,
      scope: scope === null ? null : { level: scope, readOnly: scope === 'read' },
    },
    verifier,
    projectVisible: false,
    principalStatus: 'active' as const,
    validation: { kind: 'local' as const, identityId: null, fresh: true, evidenceAt: null },
    project: null,
    organizationPermissions: [],
    projectPermissions: [],
  }));
  const authorization =
    override ??
    createAuthorizationEngine({
      access: {
        lookupToken,
        lookupSession: async () => null,
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: { keyring, nowMs: () => 0, dispatch: () => {}, log: () => {} },
      patValidation: patValidationGate,
      publicOrigin: ORIGIN,
      providerAnchors: async () => [],
    });
  const handler = vi.fn(async () => ({ ok: true }));
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    ports: context().ports,
    resolveOrg: async () => orgContext('org-a'),
    health: async () => true,
    log: () => {},
    authorization,
    coreRoutes: createMcpRoutes({ handlers: { 'tools/list': handler }, publicOrigin: ORIGIN }),
  });
  return { kernel, handler, lookupToken };
}

describe('MCP mounted authorization boundary', () => {
  it('admits a verified read PAT through the real engine', async () => {
    const { kernel, handler } = await mounted();
    const response = await kernel.fetch(context(toolCall).request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('admits a verified read service token through the real engine', async () => {
    const { kernel, handler } = await mounted('read', undefined, 'svc');
    const response = await kernel.fetch(
      context(toolCall, { principal: { kind: 'service', id: 'svc-1' } }).request,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('returns generic 403 for a verified write service token through the real engine', async () => {
    const { kernel, handler, lookupToken } = await mounted('write', undefined, 'svc');
    const response = await kernel.fetch(
      context(toolCall, { principal: { kind: 'service', id: 'svc-1' } }).request,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { ...forbidden.error, requestId: response.headers.get('x-request-id') },
    });
    expect(lookupToken).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });
  it.each(['write', 'full'] as const)('returns generic 403 for verified %s PATs', async (scope) => {
    const { kernel, handler } = await mounted(scope);
    const response = await kernel.fetch(context(toolCall).request);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { ...forbidden.error, requestId: response.headers.get('x-request-id') },
    });
    expect(handler).not.toHaveBeenCalled();
  });
  it.each(['pat', 'svc'] as const)(
    'returns the missing-credential 401 for a null-scope %s through the real engine',
    async (kind) => {
      const { kernel, handler, lookupToken } = await mounted(null, undefined, kind);
      const response = await kernel.fetch(
        context(toolCall, { headers: { authorization: `Bearer ${token(kind)}` } }).request,
      );
      const missing = await kernel.fetch(
        context(toolCall, { headers: { authorization: '' } }).request,
      );
      expect(response.status).toBe(401);
      expect(response.status).toBe(missing.status);
      expect(await response.json()).toEqual({
        error: { ...unauthorized.error, requestId: response.headers.get('x-request-id') },
      });
      expect(await missing.json()).toEqual({
        error: { ...unauthorized.error, requestId: missing.headers.get('x-request-id') },
      });
      const headers = new Headers(response.headers);
      const missingHeaders = new Headers(missing.headers);
      headers.delete('x-request-id');
      missingHeaders.delete('x-request-id');
      expect(Object.fromEntries(headers)).toEqual(Object.fromEntries(missingHeaders));
      expect(lookupToken).toHaveBeenCalledTimes(1);
      expect(handler).not.toHaveBeenCalled();
    },
  );
  it('returns the missing-credential 401 for a customer token through the real engine', async () => {
    const { kernel, handler, lookupToken } = await mounted();
    const response = await kernel.fetch(
      context(toolCall, { headers: { authorization: `Bearer ${token('cst')}` } }).request,
    );
    const missing = await kernel.fetch(
      context(toolCall, { headers: { authorization: '' } }).request,
    );
    expect(response.status).toBe(401);
    expect(response.status).toBe(missing.status);
    expect(await response.json()).toEqual({
      error: { ...unauthorized.error, requestId: response.headers.get('x-request-id') },
    });
    expect(await missing.json()).toEqual({
      error: { ...unauthorized.error, requestId: missing.headers.get('x-request-id') },
    });
    const headers = new Headers(response.headers);
    const missingHeaders = new Headers(missing.headers);
    headers.delete('x-request-id');
    missingHeaders.delete('x-request-id');
    expect(Object.fromEntries(headers)).toEqual(Object.fromEntries(missingHeaders));
    expect(lookupToken).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
  it('uses the canonical 401 envelope for engine denial and missing engine snapshot', async () => {
    for (const authorization of [
      { authorize: async () => ({ allow: false as const, status: 401 as const }) },
      {
        authorize: async () => ({
          allow: true as const,
          principal: { kind: 'user' as const, id: 'user-1' },
          projectId: null,
        }),
      },
    ]) {
      const { kernel, handler } = await mounted('read', authorization);
      const response = await kernel.fetch(context(toolCall).request);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { ...unauthorized.error, requestId: response.headers.get('x-request-id') },
      });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(handler).not.toHaveBeenCalled();
    }
  });
});

describe('MCP gate', () => {
  it('admits a read PAT without Origin and dispatches once with its context', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const ctx = context({ ...ping, method: 'tools/list', params: { cursor: 'next' } });
    const response = await fixture({ 'tools/list': handler }).post(ctx);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(handler).toHaveBeenCalledExactlyOnceWith({ cursor: 'next' }, ctx);
  });
  it('admits a read service token', async () => {
    expect(
      (await fixture().post(context(ping, { principal: { kind: 'service', id: 'svc-1' } }))).status,
    ).toBe(200);
  });
  it.each(['write', 'full'] as const)(
    'refuses a service token with scope %s before dispatch',
    async (scope) => {
      const handler = vi.fn();
      const response = await fixture({ 'tools/list': handler }).post(
        context(toolCall, { principal: { kind: 'service', id: 'svc-1' }, scope }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(forbidden);
      expect(handler).not.toHaveBeenCalled();
    },
  );
  it.each(['write', 'full', null] as const)(
    'refuses scope %s uniformly before dispatch',
    async (scope) => {
      const handler = vi.fn();
      const response = await fixture({ 'tools/list': handler }).post(context(toolCall, { scope }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(forbidden);
      expect(handler).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['missing credential', { authorization: '' }],
    ['cookie only', { authorization: '', cookie: 'pb_session=fixture' }],
    ['Basic', { authorization: `Basic ${btoa(`${token()}:x`)}` }],
    ['malformed Bearer', { authorization: 'Bearer malformed' }],
  ] as const)('refuses %s with the same 401', async (_name, headers) => {
    const response = await fixture().post(context(ping, { headers }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(unauthorized);
  });
  it('refuses a missing access snapshot', async () => {
    const response = await fixture().post(context(ping, { snapshot: false }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(unauthorized);
  });
  it('refuses a session even with a Bearer header', async () => {
    const response = await fixture().post(context(ping, { session: true }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(unauthorized);
  });
  it('refuses missing token metadata', async () => {
    const response = await fixture().post(context(ping, { noToken: true }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(forbidden);
  });
  it('refuses a customer principal and token', async () => {
    const response = await fixture().post(
      context(ping, {
        principal: { kind: 'customer', id: 'customer-1' },
        headers: { authorization: `Bearer ${token('cst')}` },
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(forbidden);
  });
  it('refuses a foreign Origin before reading or dispatching', async () => {
    const handler = vi.fn();
    const ctx = context(toolCall, { headers: { origin: 'https://evil.example' } });
    const response = await fixture({ 'tools/list': handler }).post(ctx);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(forbidden);
    expect(handler).not.toHaveBeenCalled();
    expect(ctx.request.bodyUsed).toBe(false);
  });
  it('admits the public Origin and ignores cookies', async () => {
    const response = await fixture().post(
      context(ping, { headers: { origin: ORIGIN, cookie: 'pb_session=fixture' } }),
    );
    expect(response.status).toBe(200);
  });
});

describe('MCP transport', () => {
  it.each(['2099-01-01', ''])(
    'refuses unsupported MCP-Protocol-Version %j before reading or dispatching',
    async (protocolVersion) => {
      const handler = vi.fn(async () => ({ ok: true }));
      const ctx = context(toolCall, { headers: { 'MCP-Protocol-Version': protocolVersion } });
      const response = await fixture({ 'tools/list': handler }).post(ctx);
      expect(handler).not.toHaveBeenCalled();
      expect(ctx.request.bodyUsed).toBe(false);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: 'invalid_request', message: 'Invalid request', requestId: 'req-1' },
      });
      expect(Object.fromEntries(response.headers)).toEqual({
        'cache-control': 'no-store',
        'content-type': 'application/json',
        'x-request-id': 'req-1',
      });
    },
  );
  it('dispatches with a supported MCP-Protocol-Version header', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const ctx = context(toolCall, { headers: { 'MCP-Protocol-Version': '2025-11-25' } });
    const response = await fixture({ 'tools/list': handler }).post(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(handler).toHaveBeenCalledExactlyOnceWith(undefined, ctx);
  });
  it('dispatches with no MCP-Protocol-Version header', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const ctx = context(toolCall);
    expect(ctx.request.headers.has('MCP-Protocol-Version')).toBe(false);
    const response = await fixture({ 'tools/list': handler }).post(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(handler).toHaveBeenCalledExactlyOnceWith(undefined, ctx);
  });
  it('rejects a deadline above the supported timer maximum', () => {
    expect(() => fixture({}, 2 ** 31)).toThrow(TypeError);
  });
  it('allows a handler to finish with the maximum supported deadline', async () => {
    vi.useFakeTimers();
    const handler = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve({ done: true }), 50)),
    );
    const pending = fixture({ slow: handler }, 2 ** 31 - 1).post(
      context({ ...ping, method: 'slow' }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { done: true } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('exports valid core route metadata and a GET 405 REST envelope', async () => {
    const { routes, get } = fixture();
    expect(routes.find((r) => r.method === 'POST')).toMatchObject({
      path: '/_pb/mcp',
      boundary: 'authenticated',
      permission: null,
      bearerOnly: true,
      api: { exempt: 'mcp' },
    });
    for (const route of routes) {
      expect(routeBoundaryProblems(route, 'mcp', { allowAuthenticated: true })).toEqual([]);
      expect(routeApiProblems(route, 'mcp', { requireApi: true })).toEqual([]);
    }
    const response = await get(context(undefined, { method: 'GET', snapshot: false }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(await response.json()).toEqual({
      error: { code: 'method_not_allowed', message: 'Method not allowed', requestId: 'req-1' },
    });
  });
  it('refuses a batch without invoking a handler', async () => {
    const handler = vi.fn();
    const response = await fixture({ 'tools/list': handler }).post(context([toolCall]));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' },
    });
    expect(handler).not.toHaveBeenCalled();
  });
  it.each([
    null,
    1,
    {},
    { ...ping, jsonrpc: '1.0' },
    { ...ping, id: null },
    { ...ping, method: 1 },
    { ...ping, params: 1 },
  ])('refuses invalid request %j', async (body) => {
    const response = await fixture().post(context(body));
    expect(await response.json()).toMatchObject({ error: { code: -32600 } });
  });
  it('answers a notification with 202 and an empty body', async () => {
    const handler = vi.fn(async () => ({ ignored: true }));
    const response = await fixture({ 'notifications/initialized': handler }).post(
      context({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('ignores an unknown notification with 202', async () => {
    const response = await fixture().post(
      context({ jsonrpc: '2.0', method: 'notifications/unknown' }),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });
  it.each(['unknown', 'toString', 'constructor'])('refuses unknown method %s', async (method) => {
    const response = await fixture().post(context({ ...ping, method }));
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found' },
    });
  });
  it('answers ping itself with no session or cache', async () => {
    const handler = vi.fn();
    const response = await fixture({ ping: handler }).post(context(ping));
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('mcp-session-id')).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });
  it.each(['2025-11-25', 'future'])(
    'initializes protocol %s with tool capabilities',
    async (protocolVersion) => {
      const response = await fixture().post(
        context({
          ...ping,
          method: 'initialize',
          params: { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } },
        }),
      );
      expect(await response.json()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'package-broker' },
        },
      });
    },
  );
  it.each([
    ['omitted params', undefined],
    ['wrong field types', { protocolVersion: 123, capabilities: null, clientInfo: null }],
    ['missing protocol version', { capabilities: {}, clientInfo: { name: 'test', version: '1' } }],
    [
      'missing capabilities',
      { protocolVersion: '2025-11-25', clientInfo: { name: 'test', version: '1' } },
    ],
    [
      'array capabilities',
      {
        protocolVersion: '2025-11-25',
        capabilities: [],
        clientInfo: { name: 'test', version: '1' },
      },
    ],
    ['missing client info', { protocolVersion: '2025-11-25', capabilities: {} }],
    [
      'missing client name',
      { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { version: '1' } },
    ],
    [
      'invalid client version',
      { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: 1 } },
    ],
  ])('refuses initialization with %s', async (_name, params) => {
    const handler = vi.fn();
    const response = await fixture({ initialize: handler }).post(
      context({ ...ping, method: 'initialize', ...(params === undefined ? {} : { params }) }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'Invalid params' },
    });
    expect(handler).not.toHaveBeenCalled();
  });
  it('maps malformed JSON to a protocol parse error', async () => {
    const response = await fixture().post(context('{'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  });
  it('refuses a non-JSON content type before dispatch', async () => {
    const handler = vi.fn();
    const response = await fixture({ 'tools/list': handler }).post(
      context(toolCall, { headers: { 'content-type': 'text/plain' } }),
    );
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: { code: 'unsupported_media_type' } });
    expect(handler).not.toHaveBeenCalled();
  });
  it.each([
    ['64 KiB + 1', ' '.repeat(65537), 413, 'payload_too_large'],
    ['depth 17', '['.repeat(17) + '0' + ']'.repeat(17), 400, 'invalid_request'],
  ] as const)('refuses %s before JSON.parse or dispatch', async (_name, body, status, code) => {
    const ctx = context(body);
    const handler = vi.fn();
    const parse = vi.spyOn(JSON, 'parse');
    const response = await fixture({ 'tools/list': handler }).post(ctx);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(handler).not.toHaveBeenCalled();
  });
  it.each([
    [403, 'forbidden', 'Access denied'],
    [404, 'not_found', 'Not found'],
  ] as const)(
    'maps an explicit tool denial to a uniform HTTP %s',
    async (status, code, message) => {
      const handler = vi.fn(async () => {
        throw new McpHttpError(code);
      });
      const response = await fixture({ 'tools/list': handler }).post(context(toolCall));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: { code, message, requestId: 'req-1' } });
      expect(Object.fromEntries(response.headers)).toEqual({
        'cache-control': 'no-store',
        'content-type': 'application/json',
        'x-request-id': 'req-1',
      });
    },
  );
  it('preserves HTTP denials for notifications', async () => {
    const response = await fixture({
      'tools/list': async () => {
        throw new McpHttpError('forbidden');
      },
    }).post(context({ jsonrpc: '2.0', method: 'tools/list' }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(forbidden);
  });
  it('cancels a stalled upload at the deadline without dispatching', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
      },
      cancel,
    });
    const ctx = context();
    const request = new Request(ctx.request, { body, duplex: 'half' } as RequestInit);
    const handler = vi.fn(async () => ({}));
    // Preserve the authenticated snapshot on the context carrying the streaming request.
    const streamingCtx = { ...ctx, request };
    setAccessContext(streamingCtx, accessContextOf(ctx)!);
    const responsePending = fixture({ 'tools/list': handler }, 25).post(streamingCtx);
    let completed = false;
    void responsePending.then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(24);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toBe(true);
    const response = await responsePending;
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Internal error' },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('shares one deadline between upload and handler execution', async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(toolCall)));
          controller.close();
        }, 15);
      },
    });
    const ctx = context();
    const request = new Request(ctx.request, { body, duplex: 'half' } as RequestInit);
    const streamingCtx = { ...ctx, request };
    setAccessContext(streamingCtx, accessContextOf(ctx)!);
    const handler = vi.fn(() => new Promise(() => {}));
    const pending = fixture({ 'tools/list': handler }, 25).post(streamingCtx);
    let completed = false;
    void pending.then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(15);
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(completed).toBe(true);
    expect(await (await pending).json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'Internal error' },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cuts off a slow handler at 10 seconds without its late result', async () => {
    vi.useFakeTimers();
    const handler = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve({ partial: true }), 10001)),
    );
    const pending = fixture({ slow: handler }).post(context({ ...ping, method: 'slow' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    let completed = false;
    void pending.then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'Internal error' },
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(text).not.toContain('partial');
  });
  it('clears the configurable deadline after a successful call', async () => {
    vi.useFakeTimers();
    const response = await fixture({ fast: async () => 'done' }, 25).post(
      context({ ...ping, method: 'fast' }),
    );
    expect(await response.json()).toMatchObject({ result: 'done' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('allows invalid params errors without exposing exception text', async () => {
    const response = await fixture({
      bad: async () => {
        throw new McpError(-32602);
      },
    }).post(context({ ...ping, method: 'bad' }));
    expect(await response.json()).toMatchObject({
      error: { code: -32602, message: 'Invalid params' },
    });
  });
  it('hides unexpected handler exception messages', async () => {
    const response = await fixture({
      bad: async () => {
        throw new Error('private diagnostic');
      },
    }).post(context({ ...ping, method: 'bad' }));
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'Internal error' },
    });
  });
});
