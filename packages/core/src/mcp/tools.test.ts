import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toJsonSchema } from '../api/json-schema.js';
import type { ApiRouteSpec } from '../api/route.js';
import { getMeSpec } from '../api/routes/organization-schemas.js';
import { organizationRoutes } from '../api/routes/organization.js';
import { PACKAGE_API_SPECS } from '../api/routes/packages-schemas.js';
import { packageRoutes } from '../api/routes/packages.js';
import { PROJECT_API_SPECS } from '../api/routes/projects-schemas.js';
import { projectRoutes } from '../api/routes/projects.js';
import { setAccessContext } from '../authz/access-context.js';
import { createAuthorizationEngine, patValidationGate } from '../authz/engine.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { createKernel, type Kernel } from '../kernel/kernel.js';
import type { RequestContext } from '../plugin.js';
import { createKeyring } from '../secrets/keyring.js';
import { formatToken } from '../secrets/token-format.js';
import { hashToken } from '../secrets/token-hash.js';
import { createMcpTools } from './tools.js';
import { createMcpRoutes } from './transport.js';

const ORIGIN = 'https://broker.test';
const ID = '01JA0000000000000000000001';
const clock = fixedClock('2026-10-19T00:00:00.000Z');
const token = formatToken('pat', 'abcdefghijkl', new Uint8Array(32).fill(9));
const specs: readonly ApiRouteSpec[] = [...PROJECT_API_SPECS, ...PACKAGE_API_SPECS, getMeSpec];
const names = ['list_projects', 'get_project', 'list_packages', 'get_package_versions', 'whoami'];
const argumentsFor: Record<string, unknown> = {
  list_projects: {},
  get_project: { params: { project: 'alpha' } },
  list_packages: { params: { project: 'alpha' } },
  get_package_versions: { params: { project: 'alpha', package: ID } },
  whoami: {},
};
const paths: Record<string, string> = {
  list_projects: '/_pb/projects',
  get_project: '/_pb/projects/alpha',
  list_packages: '/_pb/projects/alpha/packages',
  get_package_versions: `/_pb/projects/alpha/packages/${ID}/versions`,
  whoami: '/_pb/me',
};

function context(): RequestContext {
  return {
    request: new Request(`${ORIGIN}/_pb/mcp`, {
      headers: { authorization: `Bearer ${token}`, cookie: 'discard=me', origin: ORIGIN },
    }),
    requestId: '11111111-1111-4111-8111-111111111111',
    org: orgContext('org-a'),
    principal: { kind: 'user', id: 'user-1' },
    projectId: null,
    params: {},
    ports: { organizations: { get: async () => null }, clock, ids: { ulid: () => ID } },
  };
}

function fixture(body: unknown = { ok: true }, status = 200) {
  const fetch = vi.fn<Kernel['fetch']>(async () => Response.json(body, { status }));
  const handlers = createMcpTools({ routes: specs, publicOrigin: ORIGIN, kernel: { fetch } });
  const call = (name: string, args: unknown = argumentsFor[name]) =>
    handlers['tools/call']!({ name, arguments: args }, context());
  return { handlers, fetch, call };
}

function postTool(
  f: ReturnType<typeof fixture>,
  params: unknown,
  options: { id?: string | number; timeoutMs?: number; uploadMs?: number } = {},
): Promise<Response> {
  const message = JSON.stringify({
    jsonrpc: '2.0',
    id: options.id ?? 1,
    method: 'tools/call',
    params,
  });
  const ctx = context();
  const request = new Request(ctx.request, {
    method: 'POST',
    headers: { ...Object.fromEntries(ctx.request.headers), 'content-type': 'application/json' },
    body:
      options.uploadMs === undefined
        ? message
        : new ReadableStream<Uint8Array>({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(new TextEncoder().encode(message));
                controller.close();
              }, options.uploadMs);
            },
          }),
    duplex: 'half',
  } as RequestInit);
  const postCtx = { ...ctx, request };
  setAccessContext(postCtx, {
    principal: ctx.principal,
    projectId: null,
    boundary: 'authenticated',
    sessionId: null,
    token: { kind: 'pat', scope: 'read', readOnly: true },
    actor: null,
    rateKey: {
      stage: 'authenticated',
      principalId: 'user-1',
      tokenSelector: 'abcdefghijkl',
      routeClass: 'authenticated',
    },
  });
  const route = createMcpRoutes({
    handlers: f.handlers,
    publicOrigin: ORIGIN,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  }).find((route) => route.method === 'POST')!;
  return Promise.resolve(route.handler(postCtx));
}

function content(result: unknown): { text: string; isError: boolean | undefined } {
  const value = result as { content: { type: string; text: string }[]; isError?: boolean };
  expect(value.content).toHaveLength(1);
  expect(value.content[0]!.type).toBe('text');
  return { text: value.content[0]!.text, isError: value.isError };
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network is forbidden'));
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('MCP registry and validation', () => {
  it('lists exactly the five flagged GET operations with the route schemas', async () => {
    const f = fixture();
    const listed = (await f.handlers['tools/list']!({}, context())) as {
      tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[];
    };
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...names].sort());
    const flagged = specs.filter((spec) => spec.api.mcp === true);
    expect(flagged).toHaveLength(5);
    for (const [index, spec] of flagged.entries()) {
      const schema = listed.tools[index]!.inputSchema;
      if (spec.api.params)
        expect(schema.properties['params']).toEqual(toJsonSchema(spec.api.params, 'input'));
      if (spec.api.query)
        expect(schema.properties['query']).toEqual(toJsonSchema(spec.api.query, 'input'));
    }
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { progressToken: 'progress-1' },
    { progressToken: 17, 'client/unused': { nested: true } },
  ])('accepts and ignores standard request metadata %j', async (_meta) => {
    const f = fixture();
    const response = await postTool(f, { name: 'whoami', _meta });
    expect(await response.json()).toMatchObject({ result: { content: [{ text: '{"ok":true}' }] } });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(new URL(f.fetch.mock.calls[0]![0].url).search).toBe('');
  });

  it.each([401, 403, 404])(
    'gives kernel %s precedence over invalid arguments for every tool',
    async (status) => {
      const raw = JSON.stringify({ error: { code: String(status), message: 'Generic refusal' } });
      const f = fixture();
      f.fetch.mockImplementation(async () => new Response(raw, { status }));
      for (const name of names) {
        const result = await f.call(name, {
          ...(argumentsFor[name] as object),
          query: { extra: 'invalid' },
        });
        expect(content(result)).toEqual({ text: raw, isError: true });
      }
      expect(f.fetch).toHaveBeenCalledTimes(names.length);
    },
  );

  it('refuses a flagged non-GET route at registration', () => {
    expect(() =>
      createMcpTools({
        routes: [{ ...getMeSpec, method: 'POST', api: { ...getMeSpec.api, mcp: true } }],
        publicOrigin: ORIGIN,
        kernel: { fetch: vi.fn() },
      }),
    ).toThrow();
  });

  it('does not expose an unflagged route', async () => {
    const handlers = createMcpTools({
      routes: [{ ...getMeSpec, api: { ...getMeSpec.api, mcp: false } }],
      publicOrigin: ORIGIN,
      kernel: { fetch: vi.fn() },
    });
    expect(await handlers['tools/list']!({}, context())).toEqual({ tools: [] });
  });

  it('rejects a non-canonical public origin', () => {
    expect(() =>
      createMcpTools({
        routes: specs,
        publicOrigin: 'https://broker.test/path',
        kernel: { fetch: vi.fn() },
      }),
    ).toThrow('Invalid public origin');
  });

  it('rejects null arguments after kernel authorization', async () => {
    const f = fixture();
    expect(content(await f.call('whoami', null)).isError).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not expose an exception containing a sentinel', async () => {
    const f = fixture();
    f.fetch.mockRejectedValue(new Error('SENTINEL_DO_NOT_ECHO'));
    const result = await f.call('whoami');
    expect(content(result).isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SENTINEL_DO_NOT_ECHO');
  });

  it('refuses a malformed JSON success without exposing its body', async () => {
    const f = fixture();
    f.fetch.mockImplementation(async () => new Response('SENTINEL_DO_NOT_ECHO'));
    const result = await f.call('whoami');
    expect(content(result).isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SENTINEL_DO_NOT_ECHO');
  });

  it('rejects an unknown tool without dispatch', async () => {
    const f = fixture();
    await expect(f.call('missing', {})).rejects.toMatchObject({ code: -32602 });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('rejects multiple calls in one request', async () => {
    const f = fixture();
    await expect(
      f.handlers['tools/call']!([{ name: 'whoami' }, { name: 'whoami' }], context()),
    ).rejects.toMatchObject({ code: -32602 });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(
    ['get_project', 'list_packages', 'get_package_versions'].flatMap((name) =>
      ['https://evil.example/x', '//evil.example'].map((project) => [name, project] as const),
    ),
  )('%s rejects URL-shaped project slug %s', async (name, project) => {
    const f = fixture();
    const result = content(
      await f.call(name, {
        params: { project, ...(name === 'get_package_versions' ? { package: ID } : {}) },
      }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text).error.details).toEqual([
      { path: '/params/project', code: 'invalid_format' },
    ]);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const request = new URL(f.fetch.mock.calls[0]![0].url);
    expect(request.origin).toBe(ORIGIN);
    expect(request.pathname).toContain(`/projects/${encodeURIComponent(project)}`);
    await f.call('get_project');
    expect(new URL(f.fetch.mock.calls[1]![0].url).host).toBe('broker.test');
  });

  it('does not echo a wrong-typed argument sentinel', async () => {
    const f = fixture();
    const result = await f.call('get_project', {
      params: { project: { secret: 'SENTINEL_DO_NOT_ECHO' } },
    });
    expect(content(result).isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SENTINEL_DO_NOT_ECHO');
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0]![0].url).not.toContain('SENTINEL_DO_NOT_ECHO');
  });

  it('does not echo unknown argument keys', async () => {
    const f = fixture();
    const result = await f.call('whoami', { SENTINEL_DO_NOT_ECHO: 'secret' });
    expect(content(result).isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SENTINEL_DO_NOT_ECHO');
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0]![0].url).not.toContain('SENTINEL_DO_NOT_ECHO');
  });

  it.each(names)(
    'dispatches %s to the kernel with only the caller Bearer and JSON accept',
    async (name) => {
      const f = fixture();
      expect(JSON.parse(content(await f.call(name)).text)).toEqual({ ok: true });
      expect(f.fetch).toHaveBeenCalledTimes(1);
      const request = f.fetch.mock.calls[0]![0];
      const url = new URL(request.url);
      expect(url.origin + url.pathname).toBe(`${ORIGIN}${paths[name]}`);
      expect(url.search).toBe(
        ['list_projects', 'list_packages', 'get_package_versions'].includes(name)
          ? '?limit=50'
          : '',
      );
      expect(request.method).toBe('GET');
      expect(Object.fromEntries(request.headers)).toEqual({
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      });
      expect(request.redirect).toBe('manual');
    },
  );

  it('pins the origin even for a permissive package path parameter', async () => {
    const f = fixture();
    await f.call('get_package_versions', {
      params: { project: 'alpha', package: 'https://evil.example/x' },
    });
    const url = new URL(f.fetch.mock.calls[0]![0].url);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe(
      '/_pb/projects/alpha/packages/https%3A%2F%2Fevil.example%2Fx/versions',
    );
  });

  it('rejects a path parameter that URL parsing would normalize', async () => {
    const f = fixture();
    expect(
      content(await f.call('get_package_versions', { params: { project: 'alpha', package: '..' } }))
        .isError,
    ).toBe(true);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])(
    'preserves the REST %s envelope bytes for every tool',
    async (status) => {
      const raw = JSON.stringify(
        {
          error: {
            code: status === 404 ? 'not_found' : status === 403 ? 'forbidden' : 'unauthorized',
            message: 'Generic refusal',
            requestId: 'request-1',
            details: [{ path: '/query/limit', code: 'invalid_type' }],
          },
        },
        null,
        2,
      );
      const f = fixture();
      f.fetch.mockImplementation(async () => new Response(raw, { status }));
      for (const name of names)
        expect(content(await f.call(name))).toEqual({ text: raw, isError: true });
    },
  );

  it('treats a redirect as an error without following it', async () => {
    const f = fixture();
    f.fetch.mockImplementation(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/SENTINEL' } }),
    );
    const result = await f.call('whoami');
    expect(content(result).isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('evil.example');
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});

async function mounted(permissions = ['project:read', 'project:packages:read']) {
  const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32) }]);
  const verifier = { secretHash: await hashToken(keyring, 1, token), pepperVersion: 1 };
  const list = vi.fn(async () => ({
    ok: true as const,
    value: {
      items: [
        { id: ID, slug: 'alpha', name: 'Alpha', status: 'active' as const, revision: 1 },
        {
          id: '01JA0000000000000000000002',
          slug: 'beta',
          name: 'Beta',
          status: 'active' as const,
          revision: 1,
        },
      ],
      nextAfterId: null,
    },
  }));
  const routes = [
    ...projectRoutes({
      clock,
      ids: { ulid: () => ID },
      clientIp: () => null,
      lister: { list },
      projects: {
        get: async () => ({
          id: ID,
          slug: 'alpha',
          name: 'Alpha',
          status: 'active',
          tokenMaxScope: 'read',
          requirePublishApproval: false,
          revision: 1,
        }),
        getBySlug: async () => null,
      },
      service: {} as Parameters<typeof projectRoutes>[0]['service'],
      idempotency: { find: async () => null },
    }),
    ...packageRoutes({
      listProject: async () => ({ items: [], next: null }),
      listOrganization: async () => ({ items: [], next: null }),
      listVersions: async () => ({ items: [], next: null }),
    }),
    organizationRoutes({
      organizations: { get: async () => ({ slug: 'org-a', name: 'Org A' }) },
      users: { get: async () => null },
    } as unknown as Parameters<typeof organizationRoutes>[0]).find(
      (route) => route.path === '/_pb/me',
    )!,
  ];
  const handlers = createMcpTools({
    routes,
    publicOrigin: ORIGIN,
    kernel: { fetch: (request) => kernel.fetch(request) },
  });
  const kernel: Kernel = await createKernel({
    platform: 'node',
    plugins: [],
    ports: context().ports,
    publicOrigin: ORIGIN,
    packageResolver: { resolve: async () => ({ kind: 'absent' }) },
    resolveOrg: async () => orgContext('org-a'),
    health: async () => true,
    log: () => {},
    coreRoutes: [...routes, ...createMcpRoutes({ handlers, publicOrigin: ORIGIN })],
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async () => null,
        touchSession: async () => true,
        touchToken: async () => true,
        lookupToken: async (_org, input) => ({
          token: {
            id: 'token-a',
            kind: 'pat',
            expired: false,
            revoked: false,
            lastUsedAt: null,
            userId: 'user-1',
            servicePrincipalId: null,
            bindingOk: true,
            boundProjectIds: [ID],
            projectMode: 'selected',
            scope: { level: 'read', readOnly: true },
          },
          verifier,
          principalStatus: 'active',
          validation: { kind: 'local', identityId: null, fresh: true, evidenceAt: null },
          projectVisible: input.projectSlug === 'alpha',
          project:
            input.projectSlug === 'alpha'
              ? { id: ID }
              : ['beta', 'invisible'].includes(input.projectSlug ?? '')
                ? { id: '01JA0000000000000000000002' }
                : null,
          organizationPermissions: [],
          projectPermissions: input.projectSlug === 'alpha' ? permissions : [],
        }),
      },
      tokenUse: { keyring, nowMs: () => 0, dispatch: () => {}, log: () => {} },
      patValidation: patValidationGate,
      publicOrigin: ORIGIN,
      providerAnchors: async () => [],
    }),
  });
  const rest = (path: string) =>
    kernel.fetch(
      new Request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${token}` } }),
    );
  const call = async (name: string, args: unknown = argumentsFor[name]) => {
    const response = await kernel.fetch(
      new Request(`${ORIGIN}/_pb/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const rpc = (await response.json()) as { result: unknown };
    return content(rpc.result);
  };
  return { rest, call, list };
}

describe('MCP through the real kernel and authorization engine', () => {
  it.each(names)('%s matches REST success', async (name) => {
    const f = await mounted();
    const rest = await f.rest(paths[name]!);
    expect(rest.status).toBe(200);
    const expected = (await rest.json()) as Record<string, unknown>;
    const tool = JSON.parse((await f.call(name)).text);
    expect(tool).toEqual(
      Array.isArray(expected['items']) ? { ...expected, cursor: expected['next'] } : expected,
    );
  });

  it.each(
    ['get_project', 'list_packages', 'get_package_versions'].flatMap((name) =>
      ['beta', 'archived', 'invisible'].map((project) => [name, project] as const),
    ),
  )('%s refuses %s identically to an absent project', async (name, project) => {
    const f = await mounted();
    const absent = await f.rest(paths[name]!.replace('alpha', 'absent'));
    expect(absent.status).toBe(404);
    const raw = await absent.text();
    const rest = await f.rest(paths[name]!.replace('alpha', project));
    expect(rest.status).toBe(404);
    expect(await rest.text()).toBe(raw);
    expect([...rest.headers]).toEqual([...absent.headers]);
    const tool = await f.call(name, {
      params: { project, ...(name === 'get_package_versions' ? { package: ID } : {}) },
    });
    expect(tool).toEqual({ text: raw, isError: true });
  });

  it.each(['get_project', 'whoami'])(
    '%s has the same unknown-query details as REST',
    async (name) => {
      const f = await mounted();
      const rest = await f.rest(`${paths[name]}?extra=ignored`);
      expect(rest.status).toBe(400);
      const body = (await rest.json()) as { error: { details: unknown } };
      const tool = await f.call(name, {
        ...(argumentsFor[name] as object),
        query: { extra: 'ignored' },
      });
      expect(JSON.parse(tool.text).error.details).toEqual(body.error.details);
    },
  );

  it.each(['beta', 'archived', 'invisible', 'absent'])(
    'preserves the REST 404 for %s with an invalid query',
    async (project) => {
      const f = await mounted();
      const rest = await f.rest(`/_pb/projects/${project}/packages?limit=wrong`);
      expect(rest.status).toBe(404);
      const tool = await f.call('list_packages', {
        params: { project },
        query: { limit: 'wrong' },
      });
      expect(tool).toEqual({ text: await rest.text(), isError: true });
    },
  );

  it('preserves the REST 403 for a visible target with an invalid query', async () => {
    const f = await mounted(['project:read']);
    const rest = await f.rest('/_pb/projects/alpha/packages?limit=wrong');
    expect(rest.status).toBe(403);
    expect(
      await f.call('list_packages', { params: { project: 'alpha' }, query: { limit: 'wrong' } }),
    ).toEqual({ text: await rest.text(), isError: true });
  });

  it('lists only project A for its read token', async () => {
    const f = await mounted();
    const result = JSON.parse((await f.call('list_projects')).text);
    expect(result.items.map((item: { id: string }) => item.id)).toEqual([ID]);
    expect(f.list.mock.calls).toHaveLength(1);
  });

  it('returns the REST generic 403 for a visible target without package permission', async () => {
    const f = await mounted(['project:read']);
    const rest = await f.rest(paths['list_packages']!);
    expect(rest.status).toBe(403);
    const tool = await f.call('list_packages');
    expect(tool).toEqual({ text: await rest.text(), isError: true });
    expect(tool.text).not.toContain('project:packages:read');
    expect(tool.text).not.toContain('alpha');
  });

  it.each(['list_projects', 'list_packages', 'get_package_versions'])(
    '%s has the same validation details as REST',
    async (name) => {
      const f = await mounted();
      const rest = await f.rest(`${paths[name]}?limit=wrong`);
      expect(rest.status).toBe(400);
      const restBody = (await rest.json()) as { error: { details: unknown } };
      const args = { ...(argumentsFor[name] as object), query: { limit: 'wrong' } };
      const tool = await f.call(name, args);
      expect(JSON.parse(tool.text).error.details).toEqual(restBody.error.details);
    },
  );
});

describe('MCP output caps', () => {
  it('returns 50 of 60 items and continues using the REST cursor without duplicates', async () => {
    const all = Array.from({ length: 60 }, (_, i) => ({
      id: `01JA${String(i).padStart(22, '0')}`,
      name: 'small',
    }));
    const f = fixture();
    f.fetch.mockImplementation(async (request) => {
      const url = new URL(request.url);
      const after = url.searchParams.get('after');
      const start = after === null ? 0 : all.findIndex((item) => item.id === after) + 1;
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const items = all.slice(start, start + limit);
      return Response.json({
        items,
        next: start + items.length < all.length ? items.at(-1)!.id : null,
      });
    });
    const first = JSON.parse(
      content(await f.call('list_projects', { query: { limit: '100' } })).text,
    );
    expect(first.items).toHaveLength(50);
    expect(first.cursor).toBe(all[49]!.id);
    const second = JSON.parse(
      content(await f.call('list_projects', { query: { after: first.cursor } })).text,
    );
    expect(second.items).toEqual(all.slice(50));
    expect(
      new Set([...first.items, ...second.items].map((item: { id: string }) => item.id)).size,
    ).toBe(60);
    const request = f.fetch.mock.calls[0]![0];
    expect(new URL(request.url).searchParams.get('limit')).toBe('50');
    expect(first.next).toBe(first.cursor);
  });

  it('cuts a page over 256 KiB at whole items and uses the smaller REST page cursor', async () => {
    const all = Array.from({ length: 60 }, (_, i) => ({
      id: `01JA${String(i).padStart(22, '0')}`,
      name: '🧪'.repeat(3000),
    }));
    const f = fixture();
    f.fetch.mockImplementation(async (request) => {
      const url = new URL(request.url);
      const after = url.searchParams.get('after');
      const start = after === null ? 0 : all.findIndex((item) => item.id === after) + 1;
      const limit = Number(url.searchParams.get('limit'));
      const items = all.slice(start, start + limit);
      return Response.json({
        items,
        next: start + items.length < all.length ? items.at(-1)!.id : null,
      });
    });
    const firstResult = await f.call('list_projects');
    expect(new TextEncoder().encode(JSON.stringify(firstResult)).byteLength).toBeLessThanOrEqual(
      256 * 1024,
    );
    const first = JSON.parse(content(firstResult).text);
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThan(50);
    expect(first.items).toEqual(all.slice(0, first.items.length));
    expect(first.cursor).toBe(first.items.at(-1).id);
    const second = JSON.parse(
      content(await f.call('list_projects', { query: { after: first.cursor } })).text,
    );
    expect(second.items[0].id).toBe(all[first.items.length]!.id);
    expect(
      new Set([...first.items, ...second.items].map((item: { id: string }) => item.id)).size,
    ).toBe(first.items.length + second.items.length);
  });

  it.each([200, 403])(
    'counts the full RPC envelope for a near-limit non-list %s result',
    async (status) => {
      const id = '🧪"\\'.repeat(32);
      const body = { name: '' };
      const result = {
        content: [{ type: 'text', text: JSON.stringify(body) }],
        ...(status === 403 ? { isError: true } : {}),
      };
      body.name = 'x'.repeat(
        256 * 1024 - new TextEncoder().encode(JSON.stringify(result)).byteLength - 8,
      );
      const f = fixture(body, status);
      const response = await postTool(f, { name: 'whoami' }, { id });
      const bytes = new TextEncoder().encode(await response.text());
      expect(bytes.byteLength).toBeLessThanOrEqual(256 * 1024);
      const rpc = JSON.parse(new TextDecoder().decode(bytes));
      expect(rpc.id).toBe(id);
      expect(JSON.parse(content(rpc.result).text).error.code).toBe('payload_too_large');
    },
  );

  it('refetches whole items when only the RPC envelope exceeds the byte cap', async () => {
    const items = [
      { id: ID, name: 'small' },
      { id: 'second', name: '' },
    ];
    const page = { items, next: null, cursor: null };
    const result = { content: [{ type: 'text', text: JSON.stringify(page) }] };
    items[1]!.name = 'x'.repeat(
      256 * 1024 - new TextEncoder().encode(JSON.stringify(result)).byteLength - 8,
    );
    const f = fixture();
    f.fetch.mockImplementation(async (request) => {
      const limit = Number(new URL(request.url).searchParams.get('limit'));
      return Response.json({ items: items.slice(0, limit), next: limit === 1 ? ID : null });
    });
    const response = await postTool(f, { name: 'list_projects' });
    const bytes = new TextEncoder().encode(await response.text());
    expect(bytes.byteLength).toBeLessThanOrEqual(256 * 1024);
    const pageResult = JSON.parse(content(JSON.parse(new TextDecoder().decode(bytes)).result).text);
    expect(pageResult.items).toEqual([items[0]]);
    expect(pageResult.cursor).toBe(ID);
  });

  it('shares the transport deadline after a slow upload and aborts internal dispatch', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.fetch.mockImplementation(() => new Promise<Response>(() => {}));
    const pending = postTool(f, { name: 'whoami' }, { timeoutMs: 25, uploadMs: 15 });
    await vi.advanceTimersByTimeAsync(15);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0]![0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(await (await pending).json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'Internal error' },
    });
    expect(f.fetch.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns a bounded error when one item cannot fit', async () => {
    const f = fixture({ items: [{ id: ID, name: 'x'.repeat(300000) }], next: null });
    const result = await f.call('list_projects');
    expect(content(result).isError).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(256 * 1024);
  });

  it('returns a bounded error for an oversized non-list result', async () => {
    const f = fixture({ name: 'x'.repeat(300000) });
    expect(content(await f.call('whoami')).isError).toBe(true);
  });

  it('ends a hanging kernel call after 10 seconds and aborts its request', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.fetch.mockImplementation(() => new Promise<Response>(() => {}));
    const pending = f.call('whoami');
    await vi.advanceTimersByTimeAsync(10000);
    expect(content(await pending).isError).toBe(true);
    expect(f.fetch.mock.calls[0]![0].signal.aborted).toBe(true);
  });
});
