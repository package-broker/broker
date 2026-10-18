import { describe, expect, it, vi } from 'vitest';
import * as catalogueModule from './catalogue.js';
import { SESSION_COOKIE } from '../auth/cookies.js';
import { orgContext } from '../db/port.js';
import type { AuthorizationRequest } from '../kernel/authorize.js';
import { createKeyring } from '../secrets/keyring.js';
import { formatToken } from '../secrets/token-format.js';
import { hashToken } from '../secrets/token-hash.js';
import { createAuthorizationEngine, packageActorOf, patValidationGate } from './engine.js';
import type { EngineTokenAccess } from './engine.js';

const read = 'project:packages:read';
const write = 'project:packages:write';
const org = orgContext('org-1');
async function fixture(kind: 'session' | 'pat' | 'svc' = 'session') {
  const state = { allowed: [read, write, 'project:settings:write', 'project:grants:write'] };
  const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
  const token = formatToken(
    kind === 'svc' ? 'svc' : 'pat',
    'abcdefghijkl',
    new Uint8Array(32).fill(9),
  );
  const verifier = { secretHash: await hashToken(keyring, 1, token), pepperVersion: 1 };
  const request: AuthorizationRequest = {
    request: new Request('https://broker.test/p/demo', {
      headers:
        kind === 'session'
          ? { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` }
          : { authorization: `Bearer ${token}` },
    }),
    org,
    route: {
      plugin: 'test',
      method: 'GET',
      path: '/p/:project',
      permission: read,
      boundary: 'project',
    },
    params: { project: 'demo' },
  };
  const engine = createAuthorizationEngine({
    access: {
      lookupSession: async () => ({
        session: { id: 'session-1', csrfHash: '' },
        user: { id: 'user-1' },
        protectedHolder: false,
        project: { id: 'proj-1' },
        organizationPermissions: ['org:read'],
        projectPermissions: state.allowed,
      }),
      lookupToken: async () =>
        Object.defineProperty(
          {
            token: {
              id: 'token-1',
              kind: kind === 'svc' ? 'svc' : 'pat',
              expired: false,
              revoked: false,
              lastUsedAt: null,
              userId: kind === 'svc' ? null : 'user-1',
              servicePrincipalId: kind === 'svc' ? 'svc-1' : null,
            },
            principalStatus: 'active',
            validation:
              kind === 'svc'
                ? null
                : { kind: 'local', identityId: null, fresh: true, evidenceAt: null },
            project: { id: 'proj-1' },
            organizationPermissions: ['org:read'],
            projectPermissions: state.allowed,
          },
          'verifier',
          { value: verifier },
        ) as unknown as EngineTokenAccess,
      touchSession: async () => true,
      touchToken: async () => true,
    },
    tokenUse: { keyring, nowMs: () => 0, dispatch: () => undefined, log: () => undefined },
    patValidation: patValidationGate,
    publicOrigin: 'https://broker.test',
    providerAnchors: async () => [],
  });
  return { engine, request, state };
}
describe('package actor side channel', () => {
  it.each(['session', 'pat', 'svc'] as const)('clips and freezes the %s actor', async (kind) => {
    const { engine, request } = await fixture(kind);
    expect((await engine.authorize(request)).allow).toBe(true);
    const actor = packageActorOf(request);
    expect(actor).toMatchObject({
      kind: 'project',
      userId: kind === 'svc' ? 'svc-1' : 'user-1',
      orgId: org.orgId,
      projectId: 'proj-1',
    });
    expect([...actor!.permissions]).toEqual([read, write]);
    expect(Object.isFrozen(actor)).toBe(true);
    expect(actor?.permissions.has('project:settings:write')).toBe(false);
    expect(actor?.permissions.has('project:grants:write')).toBe(false);
    expect(packageActorOf({ ...request })).toBeNull();
  });
  it.each(['session', 'pat', 'svc'] as const)(
    'prevents widening the %s actor permissions',
    async (kind) => {
      const { engine, request } = await fixture(kind);
      expect((await engine.authorize(request)).allow).toBe(true);
      const permissions = packageActorOf(request)!.permissions;
      expect(() => (permissions as Set<string>).add('project:grants:write')).toThrow(TypeError);
      expect(permissions.has('project:grants:write')).toBe(false);
      permissions.forEach((_value, _key, view) => {
        expect(view).toBe(permissions);
        expect(() => (view as Set<string>).add('project:settings:write')).toThrow(TypeError);
      });
      expect([...permissions]).toEqual([read, write]);
    },
  );
  it.each(['pat', 'svc'] as const)('excludes sessionOnly write from the %s actor', async (kind) => {
    const original = catalogueModule.catalogueTokenEligible;
    const eligibility = vi
      .spyOn(catalogueModule, 'catalogueTokenEligible')
      .mockImplementation((name) => name !== write && original(name));
    try {
      const { engine, request } = await fixture(kind);
      expect((await engine.authorize(request)).allow).toBe(true);
      expect([...packageActorOf(request)!.permissions]).toEqual([read]);
    } finally {
      eligibility.mockRestore();
    }
  });
  it('clears the side channel when the same request is denied on reauthorization', async () => {
    const { engine, request, state } = await fixture();
    expect((await engine.authorize(request)).allow).toBe(true);
    expect(packageActorOf(request)).not.toBeNull();
    state.allowed = [];
    expect((await engine.authorize(request)).allow).toBe(false);
    expect(packageActorOf(request)).toBeNull();
  });
  it('does not mint on an organization boundary', async () => {
    const { engine, request } = await fixture();
    const organization = {
      ...request,
      route: { ...request.route, boundary: 'organization' as const, permission: 'org:read' },
    };
    expect((await engine.authorize(organization)).allow).toBe(true);
    expect(packageActorOf(organization)).toBeNull();
  });
  it.each(['pat', 'svc'] as const)(
    'refuses a sessionOnly permission for a %s token',
    async (kind) => {
      const { engine, request } = await fixture(kind);
      const sessionOnly = {
        ...request,
        route: { ...request.route, permission: 'project:settings:write' },
      };
      expect(await engine.authorize(sessionOnly)).toEqual({ allow: false, status: 403 });
      expect(packageActorOf(sessionOnly)).toBeNull();
    },
  );
});
