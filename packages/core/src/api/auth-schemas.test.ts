import { describe, expect, it, vi } from 'vitest';
import { createAuthModule, type AuthRepositories, type AuthModuleOptions } from '../auth/module.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { createKernel } from '../kernel/kernel.js';
import type { RouteDefinition } from '../plugin.js';
import { createKeyring } from '../secrets/keyring.js';
import {
  AUTH_API,
  authProvidersResponse,
  sessionResponse,
  weakPasswordErrorResponse,
} from './auth-schemas.js';
import { runApiContract } from './contract.js';
import { generateOpenApi } from './openapi.js';
import type { ApiRouteSpec } from './route.js';

const clock = fixedClock('2026-10-20T00:00:00.000Z');

function authRoutes(overrides: Partial<AuthModuleOptions> = {}): readonly RouteDefinition[] {
  return createAuthModule({
    repositories: new Proxy({}, { get: () => ({}) }) as AuthRepositories,
    keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
    clock,
    ids: { ulid: () => '01JA0000000000000000000000' },
    publicOrigin: 'https://broker.test',
    providers: new Map(),
    hooks: { 'access.check': [], 'auth.resolveIdentity': [], 'auth.mapGroups': [] },
    log: vi.fn(),
    ...overrides,
  }).coreRoutes;
}

const OPERATIONS = [
  ['get', '/_pb/auth/providers', 'listAuthProviders', 'auth'],
  ['post', '/_pb/auth/sso/{provider}/start', 'startSsoLogin', 'auth'],
  ['get', '/_pb/auth/sso/{provider}/callback', 'finishSsoLogin', 'auth'],
  ['post', '/_pb/auth/local/setup/start', 'startLocalSetup', 'auth'],
  ['post', '/_pb/auth/local/setup/finish', 'finishLocalSetup', 'auth'],
  ['post', '/_pb/auth/local/login', 'localLogin', 'auth'],
  ['post', '/_pb/auth/local/reauth', 'localReauth', 'auth'],
  ['post', '/_pb/auth/logout', 'logout', 'session'],
  ['get', '/_pb/session', 'getSession', 'session'],
] as const;

describe('auth route api slots', () => {
  it('attaches a slot to every auth module route', () => {
    const routes = authRoutes();
    expect(routes).toHaveLength(9);
    for (const route of routes) {
      expect(route.api).toBe(AUTH_API[`${route.method} ${route.path}`]);
    }
  });

  it('registers the auth module with the api requirement on', async () => {
    const kernel = await createKernel({
      platform: 'node',
      plugins: [],
      ports: {
        organizations: { get: () => Promise.resolve(null) },
        clock,
        ids: { ulid: () => 'id' },
      },
      resolveOrg: () => Promise.resolve(orgContext('org-1')),
      health: () => Promise.resolve(true),
      log: () => undefined,
      coreRoutes: authRoutes(),
    });
    expect(kernel.coreRoutes).toHaveLength(9);
  });

  it('passes the T489 contract runner for all nine auth routes on a real kernel', async () => {
    const origin = 'https://contract.invalid';
    const routes = authRoutes({
      publicOrigin: origin,
      repositories: new Proxy(
        {},
        {
          get: () => new Proxy({}, { get: () => () => Promise.resolve(null) }),
        },
      ) as AuthRepositories,
      providers: new Map([
        [
          'oidc',
          {
            id: 'oidc',
            kind: 'oidc',
            displayName: 'OIDC',
            trustAnchor: 'oidc:https://issuer.test',
            policy: { verifiedDomains: [], autoJoin: false },
            supportsReauth: true,
            start: () =>
              Promise.resolve({
                kind: 'redirect',
                location: 'https://issuer.test/authorize',
                state: {},
              }),
            finish: () => Promise.resolve({ ok: false, reason: 'missing_credentials' }),
          },
        ],
      ]),
    });
    const kernel = await createKernel({
      platform: 'node',
      plugins: [],
      ports: {
        organizations: { get: () => Promise.resolve(null) },
        clock,
        ids: { ulid: () => 'contract-request' },
      },
      resolveOrg: () => Promise.resolve(orgContext('org-1')),
      health: () => Promise.resolve(true),
      log: vi.fn(),
      coreRoutes: routes,
    });
    const headers = { origin };
    const specs = routes as unknown as readonly ApiRouteSpec[];
    const call = vi.fn((request: Request) => kernel.fetch(request));
    expect(
      await runApiContract({
        specs,
        document: generateOpenApi(specs, { title: 'Auth contract', version: '1' }),
        call,
        samples: {
          listAuthProviders: {},
          startSsoLogin: {
            params: { provider: 'oidc' },
            body: { purpose: 'login', returnTo: '/' },
            headers: { ...headers, accept: 'application/json' },
          },
          finishSsoLogin: { params: { provider: 'oidc' } },
          startLocalSetup: { body: { token: 'T'.repeat(43) }, headers },
          finishLocalSetup: {
            body: { token: 'T'.repeat(43), password: 'password', code: '000000' },
            headers,
          },
          localLogin: {
            body: { email: 'unknown@example.test', password: 'wrong', code: '000000' },
            headers,
          },
          localReauth: { body: { password: 'wrong', code: '000000' }, headers },
          logout: { headers },
          getSession: {},
        },
      }),
    ).toEqual([]);
    expect(call).toHaveBeenCalledTimes(24);
  });

  describe('generated OpenAPI document', () => {
    const document = generateOpenApi(authRoutes() as unknown as readonly ApiRouteSpec[], {
      title: 'Package Broker',
      version: '2.0.0',
    });

    it.each(OPERATIONS)('documents %s %s as %s', (method, path, operationId, tag) => {
      const operation = document.paths[path]?.[method] as Record<string, unknown> | undefined;
      expect(operation?.['operationId']).toBe(operationId);
      expect(operation?.['tags']).toEqual([tag]);
    });

    it('documents both the JSON and the redirect answer of the SSO start', () => {
      const responses = (
        document.paths['/_pb/auth/sso/{provider}/start']?.['post'] as {
          responses: Record<string, { content?: unknown }>;
        }
      ).responses;
      expect(responses['200']?.content).toMatchObject({
        'application/json': {
          schema: { type: 'object', required: ['location'], additionalProperties: false },
        },
      });
      expect(responses['303']).toEqual({ description: 'No content' });
    });
  });

  describe('response schemas', () => {
    it('describes the nonempty weak-password problem code array without accepting extra data', () => {
      const error = {
        code: 'weak_password',
        message: 'Password does not meet the requirements',
        requestId: 'req',
        problems: ['too_short', 'too_long', 'equals_email', 'not_well_formed'],
      };
      expect(weakPasswordErrorResponse.safeParse({ error }).success).toBe(true);
      for (const problems of [[], ['unknown'], 'too_short', [42], undefined]) {
        expect(weakPasswordErrorResponse.safeParse({ error: { ...error, problems } }).success).toBe(
          false,
        );
      }
      expect(
        weakPasswordErrorResponse.safeParse({ error: { ...error, password: 'secret' } }).success,
      ).toBe(false);
    });

    it('accepts the provider list the route returns', () => {
      expect(
        authProvidersResponse.safeParse({
          providers: [{ id: 'oidc', kind: 'oidc', displayName: 'OIDC', supportsReauth: true }],
          local: true,
        }).success,
      ).toBe(true);
    });

    it('rejects a provider list with an extra field', () => {
      expect(
        authProvidersResponse.safeParse({ providers: [], local: true, extra: 1 }).success,
      ).toBe(false);
    });

    it('rejects a session with an extra user field', () => {
      expect(
        sessionResponse.safeParse({
          user: { id: 'u', email: 'x', displayName: null, role: 'admin' },
          reauthFresh: false,
          expiresAt: '2026-10-20T00:00:00.000Z',
        }).success,
      ).toBe(false);
    });
  });
});
