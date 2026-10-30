import { expect, it, vi } from 'vitest';
import { sha256Hex } from '../../auth/primitives.js';
import {
  createAuthorizationEngine,
  patValidationGate,
  type EngineTokenAccess,
} from '../../authz/engine.js';
import { orgContext } from '../../db/port.js';
import { fixedClock } from '../../ids.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { formatToken } from '../../secrets/token-format.js';
import { hashToken } from '../../secrets/token-hash.js';
import { auditHealthRoutes } from './audit-status.js';

async function fixture(permissions = ['org:audit:read'], wired = true) {
  const secret = 'A'.repeat(43);
  const token = formatToken('svc', 'abcdefghijkl', new Uint8Array(32).fill(9));
  const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]);
  const read = vi.fn(async () => ({
    status: 'degraded' as const,
    codes: ['audit.skipped' as const],
    endpoint: 'https://private.test/token',
    email: 'private@example.test',
  }));
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: auditHealthRoutes(wired ? { read } : undefined),
    ports: {
      organizations: { get: async () => null },
      clock: fixedClock('2026-10-30T00:00:00.000Z'),
      ids: { ulid: () => 'test' },
    },
    resolveOrg: async () => orgContext('org-a'),
    health: async () => true,
    log: () => {},
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async (_ctx, input) =>
          input.secretHash === (await sha256Hex(secret))
            ? {
                session: { id: 'session', csrfHash: '' },
                user: { id: 'user' },
                identity: null,
                protectedHolder: false,
                project: null,
                organizationPermissions: permissions,
                projectPermissions: [],
              }
            : null,
        lookupToken: async () =>
          Object.defineProperty(
            {
              token: {
                id: 'token',
                kind: 'svc',
                expired: false,
                revoked: false,
                lastUsedAt: null,
                userId: null,
                servicePrincipalId: 'principal',
                bindingOk: true,
                projectMode: 'all',
                scope: { level: 'read', readOnly: true },
              },
              protectedHolder: false,
              principalStatus: 'active',
              projectVisible: true,
              validation: null,
              project: null,
              organizationPermissions: permissions,
              projectPermissions: [],
            },
            'verifier',
            { value: { secretHash: await hashToken(keyring, 1, token), pepperVersion: 1 } },
          ) as unknown as EngineTokenAccess,
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: { keyring, nowMs: () => 0, dispatch: () => {}, log: () => {} },
      patValidation: patValidationGate,
      publicOrigin: 'https://broker.test',
      providerAnchors: async () => [],
    }),
  });
  return {
    read,
    request: (auth: 'session' | 'service' | 'none' = 'session') =>
      kernel.fetch(
        new Request('https://broker.test/_pb/audit/health', {
          headers:
            auth === 'session'
              ? { cookie: `__Host-pb_session=${secret}` }
              : auth === 'service'
                ? { authorization: `Bearer ${token}` }
                : {},
        }),
      ),
  };
}
it.each(['session', 'service'] as const)(
  'permits organization audit readers using %s credentials and exposes only health codes',
  async (auth) => {
    const f = await fixture();
    const response = await f.request(auth);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'degraded', codes: ['audit.skipped'] });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(f.read).toHaveBeenCalledWith(orgContext('org-a'));
  },
);
it.each([{ permissions: [] }, { permissions: ['project:audit:read'] }])(
  'denies callers without organization audit permission: %j',
  async ({ permissions }) => {
    const f = await fixture(permissions);
    expect((await f.request()).status).toBe(403);
    expect(f.read).not.toHaveBeenCalled();
  },
);
it('requires authentication', async () => {
  const f = await fixture();
  expect((await f.request('none')).status).toBe(401);
  expect(f.read).not.toHaveBeenCalled();
});

it('returns the unavailable stub for an unwired health service', async () => {
  const f = await fixture(['org:audit:read'], false);
  const response = await f.request();
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: {
      code: 'audit_trail_unavailable',
      message: 'Audit trail unavailable',
      requestId: expect.any(String),
    },
  });
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(f.read).not.toHaveBeenCalled();
});
