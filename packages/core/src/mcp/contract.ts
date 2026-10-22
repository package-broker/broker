import { base32Decode, totpCode } from '../auth/totp.js';
import { ulid } from '../ids.js';
import type { McpRateLimitBinding } from './limit.js';

const PASSWORD = 'correct horse battery staple 42';
const EMAIL = 'admin@example.test';
const SELECTOR_PATTERN = /^[A-Za-z0-9]{12}$/;

export type McpRuntime = 'node' | 'workers';
type Handler = (request: Request) => Response | Promise<Response>;

export interface McpContractBroker {
  readonly origin: string;
  readonly tokens: {
    readonly read: string;
    readonly write: string;
    readonly full: string;
    readonly readAlphaService: string;
  };
  readonly cookie: string;
  readonly packagesInAlpha: number;
  mcp(request: Request): Promise<Response>;
  rest(request: Request): Promise<Response>;
  /** Replaces what the MCP tools reach through the kernel; null restores the real routes. */
  stubRest(handler: Handler | null): void;
  close(): Promise<void>;
}

export interface McpContractFactory {
  readonly runtime: McpRuntime;
  /** Rejects with the runtime startup error on Workers when `binding` is absent. */
  create(options: { readonly binding?: McpRateLimitBinding }): Promise<McpContractBroker>;
}

export interface McpFixtureInput {
  readonly origin: string;
  readonly call: (request: Request) => Promise<Response>;
  readonly setupToken: string;
  readonly orgId: string;
  readonly seedPackages: (seed: {
    readonly orgId: string;
    readonly projectId: string;
    readonly count: number;
  }) => Promise<void>;
}

const PACKAGE_COUNT = 60;

function json(origin: string, path: string, init: RequestInit & { json?: unknown } = {}) {
  const { json: body, headers, ...rest } = init;
  return new Request(`${origin}${path}`, {
    ...rest,
    headers: {
      origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function cookieHeader(responses: readonly Response[]): string {
  const jar = new Map<string, string>();
  for (const response of responses) {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0] as string;
      const at = pair.indexOf('=');
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Signs the seeded administrator in, creates projects and packages and issues the contract's tokens. */
export async function provisionMcpFixture(input: McpFixtureInput) {
  const { origin, call, setupToken } = input;
  const ok = async (request: Request, status: number) => {
    const response = await call(request);
    if (response.status !== status) {
      throw new Error(`fixture request failed: expected ${status}, got ${response.status}`);
    }
    return response;
  };
  const started = await ok(
    json(origin, '/_pb/auth/local/setup/start', { method: 'POST', json: { token: setupToken } }),
    200,
  );
  const totpSecret = base32Decode(((await started.json()) as { secret: string }).secret);
  const step = Math.floor(Date.now() / 30_000);
  await ok(
    json(origin, '/_pb/auth/local/setup/finish', {
      method: 'POST',
      json: { token: setupToken, password: PASSWORD, code: await totpCode(totpSecret, step - 1) },
    }),
    204,
  );
  const signedIn = await ok(
    json(origin, '/_pb/auth/local/login', {
      method: 'POST',
      json: { email: EMAIL, password: PASSWORD, code: await totpCode(totpSecret, step) },
    }),
    204,
  );
  const cookie = cookieHeader([signedIn]);
  const csrf = /__Host-pb_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
  await ok(
    json(origin, '/_pb/auth/local/reauth', {
      method: 'POST',
      json: { password: PASSWORD, code: await totpCode(totpSecret, step + 1) },
      headers: { cookie, 'x-csrf-token': csrf },
    }),
    204,
  );
  const session = { cookie, 'x-csrf-token': csrf };

  const projectIds: Record<string, string> = {};
  for (const slug of ['alpha', 'beta']) {
    const created = await ok(
      json(origin, '/_pb/projects', {
        method: 'POST',
        json: { slug, name: slug },
        headers: session,
      }),
      201,
    );
    projectIds[slug] = ((await created.json()) as { id: string }).id;
  }

  await input.seedPackages({
    orgId: input.orgId,
    projectId: projectIds['alpha']!,
    count: PACKAGE_COUNT,
  });

  const issue = async (scope: string) => {
    const issued = await ok(
      json(origin, '/_pb/me/tokens', {
        method: 'POST',
        json: { name: `contract-${scope}`, scope, projectMode: 'all', projectIds: [] },
        headers: { ...session, 'idempotency-key': ulid() },
      }),
      201,
    );
    return ((await issued.json()) as { token: string }).token;
  };
  const principal = await ok(
    json(origin, '/_pb/service-principals', {
      method: 'POST',
      json: {
        name: 'contract-alpha-reader',
        project: projectIds['alpha'],
        permissions: ['project:read', 'project:packages:read'],
      },
      headers: { ...session, 'idempotency-key': ulid() },
    }),
    201,
  );
  const servicePrincipalId = ((await principal.json()) as { id: string }).id;
  const issuedService = await ok(
    json(origin, '/_pb/projects/alpha/tokens', {
      method: 'POST',
      json: { servicePrincipalId, name: 'contract-alpha-service', scope: 'read' },
      headers: { ...session, 'idempotency-key': ulid() },
    }),
    201,
  );
  return {
    orgId: input.orgId,
    cookie,
    packagesInAlpha: PACKAGE_COUNT,
    tokens: {
      read: await issue('read'),
      write: await issue('write'),
      full: await issue('full'),
      readAlphaService: ((await issuedService.json()) as { token: string }).token,
    },
  };
}

interface ToolEnvelope {
  readonly isError?: boolean;
  readonly content: readonly { readonly type: string; readonly text: string }[];
}

interface Refusal {
  readonly error: { readonly code: string; readonly details?: readonly unknown[] };
  readonly requestId?: string;
}

const encoder = new TextEncoder();
const CAP_BYTES = 256 * 1024;

function withoutRequestId(text: string): unknown {
  const value = JSON.parse(text) as Record<string, unknown>;
  delete value['requestId'];
  const error = value['error'];
  if (typeof error === 'object' && error !== null)
    delete (error as Record<string, unknown>)['requestId'];
  return value;
}

interface Matchers {
  readonly not: Matchers;
  readonly rejects: { toMatchObject(expected: object): Promise<void> };
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toMatch(expected: RegExp): void;
  toContain(expected: unknown): void;
  toHaveLength(expected: number): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeGreaterThan(expected: number): void;
  toBeLessThan(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
}

type Hook = (run: () => void | Promise<void>, timeoutMs?: number) => void;

/** The Vitest functions the suite uses; core cannot import Vitest, so the runtime test passes them in. */
export interface McpTestHarness {
  readonly describe: (name: string, run: () => void) => void;
  readonly it: (name: string, run: () => void | Promise<void>) => void;
  readonly beforeAll: Hook;
  readonly afterAll: Hook;
  readonly beforeEach: Hook;
  readonly afterEach: Hook;
  readonly expect: (value: unknown) => Matchers;
}

/** Registers the MCP contract against a runtime's broker. */
export function runMcpContract(factory: McpContractFactory, harness: McpTestHarness): void {
  const { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } = harness;
  describe(`MCP contract (${factory.runtime})`, () => {
    let broker: McpContractBroker;
    let allowed = true;
    const limitKeys: string[] = [];
    const binding: McpRateLimitBinding = {
      limit: async ({ key }) => {
        limitKeys.push(key);
        return { success: allowed };
      },
    };
    const outbound: string[] = [];
    let realFetch = globalThis.fetch;

    beforeAll(async () => {
      realFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
          return realFetch(input, init);
        }
        outbound.push(url.origin);
        throw new Error('Network is forbidden');
      };
      broker = await factory.create({ binding });
    }, 120_000);
    afterAll(async () => {
      try {
        await broker?.close();
      } finally {
        globalThis.fetch = realFetch;
        expect(outbound).toEqual([]);
      }
    });
    beforeEach(() => {
      allowed = true;
      limitKeys.length = 0;
      expect(outbound).toEqual([]);
    });
    afterEach(() => {
      broker?.stubRest(null);
      expect(outbound).toEqual([]);
    });

    const rpc = (method: string, params?: unknown, id: number | null = 1) =>
      JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params });
    const post = (
      body: string,
      options: { token?: string | null; headers?: Record<string, string> } = {},
    ) => {
      const token = options.token === undefined ? broker.tokens.read : options.token;
      return broker.mcp(
        new Request(`${broker.origin}/_pb/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
            ...options.headers,
          },
          body,
        }),
      );
    };
    const callTool = async (name: string, args?: unknown, token?: string) => {
      const response = await post(rpc('tools/call', { name, arguments: args }), {
        token: token ?? broker.tokens.read,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { result: ToolEnvelope };
      expect(body.result.content).toHaveLength(1);
      return { ...body.result, text: body.result.content[0]!.text };
    };
    const restGet = (path: string, token: string) =>
      broker.rest(
        new Request(`${broker.origin}${path}`, { headers: { authorization: `Bearer ${token}` } }),
      );

    describe('transport and gate', () => {
      it('answers GET with 405 and the POST allow header', async () => {
        const response = await broker.mcp(
          new Request(`${broker.origin}/_pb/mcp`, {
            headers: { authorization: `Bearer ${broker.tokens.read}` },
          }),
        );
        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('POST');
      });

      it('refuses a JSON-RPC batch without executing any member', async () => {
        const response = await post(
          JSON.stringify([
            { jsonrpc: '2.0', id: 1, method: 'ping' },
            { jsonrpc: '2.0', id: 2, method: 'ping' },
          ]),
        );
        const body = (await response.json()) as { result?: unknown; error?: { code: number } };
        expect(body.result).toBeUndefined();
        expect(body.error?.code).toBe(-32600);
      });

      it('answers a notification with 202 and no body', async () => {
        const response = await post(rpc('notifications/initialized', undefined, null));
        expect(response.status).toBe(202);
        expect(await response.text()).toBe('');
      });

      it('refuses a foreign Origin with 403', async () => {
        const response = await post(rpc('ping'), { headers: { origin: 'https://evil.invalid' } });
        expect(response.status).toBe(403);
      });

      it('accepts the broker Origin', async () => {
        const response = await post(rpc('ping'), { headers: { origin: broker.origin } });
        expect(response.status).toBe(200);
      });

      it('refuses a write-scope token with 403', async () => {
        expect((await post(rpc('ping'), { token: broker.tokens.write })).status).toBe(403);
      });

      it('refuses a full-scope token with 403', async () => {
        expect((await post(rpc('ping'), { token: broker.tokens.full })).status).toBe(403);
      });

      it('refuses a session cookie without a bearer token with 401', async () => {
        const response = await post(rpc('ping'), {
          token: null,
          headers: { cookie: broker.cookie },
        });
        expect(response.status).toBe(401);
      });

      it('refuses a request without credentials with 401', async () => {
        expect((await post(rpc('ping'), { token: null })).status).toBe(401);
      });

      it('lists the five read tools', async () => {
        const response = await post(rpc('tools/list'));
        const body = (await response.json()) as { result: { tools: { name: string }[] } };
        expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
          'get_package_versions',
          'get_project',
          'list_packages',
          'list_projects',
          'whoami',
        ]);
      });
    });

    describe('refusals identical to REST', () => {
      it('answers an invisible project exactly like REST and like an unknown project', async () => {
        const rest = await restGet('/_pb/projects/beta', broker.tokens.readAlphaService);
        expect(rest.status).toBe(404);
        const mcp = await callTool(
          'get_project',
          { params: { project: 'beta' } },
          broker.tokens.readAlphaService,
        );
        expect(mcp.isError).toBe(true);
        expect(withoutRequestId(mcp.text)).toEqual(withoutRequestId(await rest.text()));
        const unknown = await callTool(
          'get_project',
          { params: { project: 'no-such-project' } },
          broker.tokens.readAlphaService,
        );
        expect(withoutRequestId(unknown.text)).toEqual(withoutRequestId(mcp.text));
      });

      const parity: [string, Record<string, string | string[]>, string | null][] = [
        ['a valid query', { limit: '5' }, null],
        ['a query of the wrong type', { limit: ['5', '10'] }, 'invalid_type'],
        ['a query with an invalid format', { limit: 'many' }, 'invalid_format'],
        ['an unknown query property', { bogus: '1' }, 'unrecognized_keys'],
      ];
      for (const [label, query, code] of parity) {
        it(`reports the REST details for ${label}`, async () => {
          const search = new URLSearchParams();
          for (const [key, value] of Object.entries(query)) {
            for (const entry of Array.isArray(value) ? value : [value]) search.append(key, entry);
          }
          const rest = await restGet(`/_pb/projects/alpha/packages?${search}`, broker.tokens.read);
          const mcp = await callTool('list_packages', {
            params: { project: 'alpha' },
            query,
          });
          if (code === null) {
            expect(rest.status).toBe(200);
            expect(mcp.isError).toBeUndefined();
            return;
          }
          expect(rest.status).toBe(400);
          expect(mcp.isError).toBe(true);
          const expected = ((await rest.json()) as Refusal).error;
          const actual = (JSON.parse(mcp.text) as Refusal).error;
          expect(actual.code).toBe(expected.code);
          expect(expected.details?.length).toBeGreaterThan(0);
          expect(expected.details?.map((detail) => (detail as { code: string }).code)).toContain(
            code,
          );
          expect(actual.details).toEqual(expected.details);
        });
      }
    });

    describe('caps', () => {
      it('returns 50 of 60 items with a cursor and continues without gaps', async () => {
        expect(broker.packagesInAlpha).toBe(60);
        const first = await callTool('list_packages', { params: { project: 'alpha' } });
        expect(first.isError).toBeUndefined();
        const page = JSON.parse(first.text) as { items: { id: string }[]; cursor: string | null };
        expect(page.items).toHaveLength(50);
        expect(page.cursor).not.toBeNull();
        const second = await callTool('list_packages', {
          params: { project: 'alpha' },
          query: { after: page.cursor },
        });
        const rest = JSON.parse(second.text) as { items: { id: string }[]; cursor: string | null };
        expect(rest.items).toHaveLength(10);
        expect(rest.cursor).toBeNull();
        const ids = [...page.items, ...rest.items].map((item) => item.id);
        expect(new Set(ids).size).toBe(60);
      });

      const paged = (all: readonly { id: string }[]): Handler => {
        return (request) => {
          const url = new URL(request.url);
          const limit = Number(url.searchParams.get('limit') ?? 50);
          const after = url.searchParams.get('after');
          const start = after === null ? 0 : all.findIndex((item) => item.id === after) + 1;
          const items = all.slice(start, start + limit);
          const last = items.at(-1);
          const next = start + limit < all.length && last !== undefined ? last.id : null;
          return Response.json({ items, next });
        };
      };

      for (const [label, body] of [
        ['ASCII', 'x'.repeat(20 * 1024)],
        ['multibyte UTF-8', 'é'.repeat(10 * 1024)],
      ]) {
        it(`cuts a 256 KiB ${label} response at a whole item`, async () => {
          const all = Array.from({ length: 20 }, (_, index) => ({
            id: `item-${String(index).padStart(2, '0')}`,
            body,
          }));
          expect(encoder.encode(body).byteLength).toBe(20 * 1024);
          if (label === 'multibyte UTF-8') {
            expect(JSON.stringify(all).length).toBeLessThan(CAP_BYTES);
            expect(encoder.encode(JSON.stringify(all)).byteLength).toBeGreaterThan(CAP_BYTES);
          }
          broker.stubRest(paged(all));
          const response = await post(
            rpc('tools/call', {
              name: 'list_packages',
              arguments: { params: { project: 'alpha' } },
            }),
          );
          expect(response.status).toBe(200);
          const raw = await response.text();
          expect(encoder.encode(raw).byteLength).toBeLessThanOrEqual(CAP_BYTES);
          const result = (JSON.parse(raw) as { result: ToolEnvelope }).result;
          expect(result.isError).toBeUndefined();
          const page = JSON.parse(result.content[0]!.text) as {
            items: typeof all;
            cursor: string | null;
          };
          expect(page.items.length).toBeGreaterThan(0);
          expect(page.items.length).toBeLessThan(20);
          expect(page.items).toEqual(all.slice(0, page.items.length));
          expect(page.cursor).toBe(page.items.at(-1)!.id);
        });
      }

      it('refuses a single item larger than the cap instead of cutting it', async () => {
        broker.stubRest(paged([{ id: 'only', body: 'x'.repeat(300 * 1024) } as { id: string }]));
        const result = await callTool('list_packages', { params: { project: 'alpha' } });
        expect(result.isError).toBe(true);
        expect((JSON.parse(result.text) as Refusal).error.code).toBe('payload_too_large');
      });

      it('treats a redirect from the handler as an error and does not follow it', async () => {
        const seen: string[] = [];
        broker.stubRest((request) => {
          seen.push(request.url);
          return new Response(null, {
            status: 302,
            headers: { location: 'https://redirect.invalid/target' },
          });
        });
        const result = await callTool('list_projects');
        expect(result.isError).toBe(true);
        expect((JSON.parse(result.text) as Refusal).error.code).toBe('bad_gateway');
        expect(result.text).not.toContain('redirect.invalid');
        expect(seen).toHaveLength(1);
      });
    });

    describe('rate limit', () => {
      if (factory.runtime === 'workers') {
        it('answers a rate-limited call with 429 and a retry hint', async () => {
          allowed = false;
          const response = await post(rpc('ping'));
          expect(response.status).toBe(429);
          expect(response.headers.get('retry-after')).toBe('60');
        });

        it('keys the binding by the token selector, never by the token', async () => {
          expect((await post(rpc('ping'))).status).toBe(200);
          expect(limitKeys).toHaveLength(1);
          expect(limitKeys[0]).toMatch(SELECTOR_PATTERN);
          expect(broker.tokens.read).toContain(limitKeys[0]!);
          expect(limitKeys[0]).not.toBe(broker.tokens.read);
        });

        it('fails to start without the rate limiting binding', async () => {
          await expect(factory.create({})).rejects.toMatchObject({
            name: 'KernelConfigError',
          });
        });
      } else {
        it('starts without a rate limiting binding and never consults it', async () => {
          const bare = await factory.create({});
          try {
            const response = await bare.mcp(
              new Request(`${bare.origin}/_pb/mcp`, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  authorization: `Bearer ${bare.tokens.read}`,
                },
                body: rpc('ping'),
              }),
            );
            expect(response.status).toBe(200);
          } finally {
            await bare.close();
          }
        });
      }
    });
  });
}
