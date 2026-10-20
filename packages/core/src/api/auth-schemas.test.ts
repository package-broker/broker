import { describe, expect, it, vi } from 'vitest';
import { createAuthModule, type AuthRepositories } from '../auth/module.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { createKernel } from '../kernel/kernel.js';
import type { RouteDefinition } from '../plugin.js';
import { createKeyring } from '../secrets/keyring.js';
import { AUTH_API, authProvidersResponse, sessionResponse } from './auth-schemas.js';
import { generateOpenApi } from './openapi.js';
import type { ApiRouteSpec } from './route.js';

const clock = fixedClock('2026-10-20T00:00:00.000Z');

function authRoutes(): readonly RouteDefinition[] {
  return createAuthModule({
    repositories: new Proxy({}, { get: () => ({}) }) as AuthRepositories,
    keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
    clock,
    ids: { ulid: () => '01JA0000000000000000000000' },
    publicOrigin: 'https://broker.test',
    providers: new Map(),
    hooks: { 'access.check': [], 'auth.resolveIdentity': [], 'auth.mapGroups': [] },
    log: vi.fn(),
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
