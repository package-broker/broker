import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../auth/cookies.js';
import { sha256Hex } from '../../auth/primitives.js';
import { createAuthorizationEngine, patValidationGate } from '../../authz/engine.js';
import type { EngineTokenAccess } from '../../authz/engine.js';
import { DEFAULT_ROLES, PERMISSIONS } from '../../authz/permissions.js';
import { orgContext } from '../../db/port.js';
import { fixedClock } from '../../ids.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { formatToken } from '../../secrets/token-format.js';
import { hashToken } from '../../secrets/token-hash.js';
import { myPermissionsRoute, myProjectPermissionsRoute } from './permissions.js';

const ORIGIN = 'https://broker.test';
const SESSION_SECRET = 'A'.repeat(43);
const SESSION_ID = 'session-sentinel';
const CSRF = 'csrf-sentinel';
const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
const token = formatToken('pat', 'abcdefghijkl', new Uint8Array(32).fill(9));
const cookie = { cookie: `${SESSION_COOKIE}=${SESSION_SECRET}` };

interface Options {
  organizationPermissions?: readonly string[];
  projectPermissions?: readonly string[];
  projectExists?: boolean;
}

function authorizationEngine(options: Options = {}) {
  const organizationPermissions = options.organizationPermissions ?? [];
  const projectPermissions = options.projectPermissions ?? ['project:read'];
  return createAuthorizationEngine({
    access: {
      lookupSession: async (_org, input) => ({
        session: { id: SESSION_ID, csrfHash: await sha256Hex(CSRF) },
        user: { id: 'user-sentinel' },
        protectedHolder: true,
        project:
          input.boundary === 'project' && options.projectExists !== false
            ? { id: 'project-sentinel' }
            : null,
        organizationPermissions,
        projectPermissions: input.boundary === 'project' ? projectPermissions : [],
      }),
      lookupToken: async () =>
        Object.defineProperty(
          {
            token: {
              id: 'token-sentinel',
              kind: 'pat',
              expired: false,
              revoked: false,
              lastUsedAt: null,
              userId: 'user-sentinel',
              servicePrincipalId: null,
              bindingOk: true,
              projectMode: 'all',
              scope: { level: 'organization', readOnly: true },
            },
            principalStatus: 'active',
            projectVisible: false,
            validation: { kind: 'local', identityId: null, fresh: true, evidenceAt: null },
            project: null,
            organizationPermissions,
            projectPermissions: [],
          },
          'verifier',
          { value: { secretHash: await hashToken(keyring, 1, token), pepperVersion: 1 } },
        ) as unknown as EngineTokenAccess,
      touchSession: async () => true,
      touchToken: async () => true,
    },
    tokenUse: {
      keyring,
      nowMs: () => Date.parse('2026-10-18T00:00:00Z'),
      dispatch: (run) => {
        void run();
      },
      log: () => undefined,
    },
    patValidation: patValidationGate,
    publicOrigin: ORIGIN,
    providerAnchors: async () => [],
  });
}

async function kernel(options: Options = {}) {
  return createKernel({
    platform: 'node',
    plugins: [],
    authorization: authorizationEngine(options),
    coreRoutes: [myPermissionsRoute(), myProjectPermissionsRoute()],
    ports: {
      organizations: { get: async () => null },
      clock: fixedClock('2026-10-18T00:00:00Z'),
      ids: { ulid: () => '01JA0000000000000000000000' },
    },
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    log: () => undefined,
  });
}

async function call(options: Options, path: string, headers: Record<string, string> = cookie) {
  const app = await kernel(options);
  return app.fetch(new Request(`${ORIGIN}${path}`, { headers }));
}

async function normalized(response: Response) {
  const body = (await response.json()) as { error: { requestId: string } };
  const { requestId, ...error } = body.error;
  expect(requestId).toEqual(expect.any(String));
  const headers = new Headers(response.headers);
  headers.delete('x-request-id');
  return { status: response.status, headers: [...headers], body: { error } };
}

describe('caller permission routes', () => {
  it('returns sorted, unique catalogue permissions for an organization admin session', async () => {
    const names = PERMISSIONS.map(({ name }) => name);
    const response = await call(
      { organizationPermissions: [...names].reverse().concat(names, ['org:unknown']) },
      '/_pb/me/permissions',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ organization: names.sort() });
  });

  it('returns sorted, unique catalogue project snapshot permissions', async () => {
    const response = await call(
      {
        projectPermissions: [
          'project:settings:write',
          'project:read',
          'project:read',
          'project:unknown',
        ],
      },
      '/_pb/projects/demo/permissions',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ project: ['project:read', 'project:settings:write'] });
  });

  it.each([
    {
      role: 'Organization Admin without direct project grants',
      organizationPermissions: DEFAULT_ROLES.find(({ key }) => key === 'organization_admin')!
        .permissions,
      projectPermissions: [],
      expected: PERMISSIONS.filter(({ scope }) => scope === 'project').map(({ name }) => name),
    },
    {
      role: 'organization and project roles with overlapping grants',
      organizationPermissions: [
        'org:users:write',
        'project:settings:write',
        'project:read',
        'project:read',
        'project:unknown',
      ],
      projectPermissions: ['project:packages:read', 'project:read', 'project:unknown'],
      expected: ['project:read', 'project:settings:write', 'project:packages:read'],
    },
  ])('matches engine permissions for $role', async (options) => {
    const projectNames = PERMISSIONS.filter(({ scope }) => scope === 'project').map(
      ({ name }) => name,
    );
    const app = await kernel(options);
    const engine = authorizationEngine(options);
    const allowed: string[] = [];
    for (const name of projectNames) {
      const decision = await engine.authorize({
        request: new Request(`${ORIGIN}/_pb/projects/demo/permissions`, { headers: cookie }),
        org: orgContext('org-1'),
        route: {
          plugin: 'core',
          method: 'GET',
          path: '/_pb/projects/:project/permissions',
          boundary: 'project',
          permission: name,
        },
        params: { project: 'demo' },
      });
      if (decision.allow) allowed.push(name);
    }
    expect(allowed.sort()).toEqual([...options.expected].sort());
    const response = await app.fetch(
      new Request(`${ORIGIN}/_pb/projects/demo/permissions`, { headers: cookie }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ project: allowed });
  });

  it('returns the same 404 for an invisible project as an absent project', async () => {
    const invisible = await call({ projectPermissions: [] }, '/_pb/projects/demo/permissions');
    const absent = await call({ projectExists: false }, '/_pb/projects/missing/permissions');
    const result = await normalized(invisible);
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: { code: 'not_found', message: 'Route not found' } });
    expect(result).toEqual(await normalized(absent));
  });

  it('returns a generic 403 for a visible project without project:read', async () => {
    const response = await call(
      { projectPermissions: ['project:settings:write'] },
      '/_pb/projects/demo/permissions',
    );
    const result = await normalized(response);
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: { code: 'forbidden', message: 'Forbidden' } });
  });

  it('returns no organization actor permissions for a token principal', async () => {
    const response = await call(
      { organizationPermissions: ['org:read', 'org:users:write'] },
      '/_pb/me/permissions',
      { authorization: `Bearer ${token}` },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ organization: [] });
  });

  it.each([
    ['/_pb/me/permissions', 'organization'],
    ['/_pb/projects/demo/permissions', 'project'],
  ])(
    'returns only the permission key on %s and excludes session and CSRF data',
    async (path, key) => {
      const response = await call({ organizationPermissions: ['org:read'] }, path);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(Object.keys(JSON.parse(text) as object)).toEqual([key]);
      for (const sentinel of [
        SESSION_ID,
        CSRF,
        'user-sentinel',
        'project-sentinel',
        'token-sentinel',
      ]) {
        expect(text).not.toContain(sentinel);
      }
    },
  );
});
