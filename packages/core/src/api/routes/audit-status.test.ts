import type { EffectiveAuditConfig } from '../../audit/effective.js';
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
import { auditHealthRoutes, auditStatusRoutes } from './audit-status.js';

async function fixture(
  permissions = ['org:audit:read'],
  wired = true,
  otherOrg = false,
  orgId = 'org-a',
) {
  const secret = 'A'.repeat(43);
  const token = formatToken('svc', 'abcdefghijkl', new Uint8Array(32).fill(9));
  const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]);
  const read = vi.fn(async () => ({
    status: 'degraded' as const,
    codes: ['audit.skipped' as const],
    endpoint: 'https://private.test/token',
    email: 'private@example.test',
  }));
  const statusRead = vi.fn(
    async (): Promise<Omit<typeof snapshot, 'mode'> & { mode: 'trail' | 'export' | 'none' }> =>
      snapshot,
  );
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: [
      ...auditHealthRoutes(wired ? { read } : undefined),
      ...auditStatusRoutes(
        wired
          ? {
              reader: { read: statusRead },
              effective: async () => effective,
              health: { read },
              modeSource: async () => 'env',
            }
          : undefined,
      ),
    ],
    ports: {
      organizations: { get: async () => null },
      clock: fixedClock('2026-10-30T00:00:00.000Z'),
      ids: { ulid: () => 'test' },
    },
    resolveOrg: async () => orgContext(orgId),
    health: async () => true,
    log: () => {},
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async (ctx, input) =>
          ctx.orgId === (otherOrg ? 'org-b' : 'org-a') &&
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
    statusRead,
    request: (auth: 'session' | 'service' | 'none' = 'session', path = '/_pb/audit/health') =>
      kernel.fetch(
        new Request(`https://broker.test${path}`, {
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

const effective: EffectiveAuditConfig = {
  policy: 'availability',
  policySource: 'build',
  persistRaise: false,
  mode: 'none',
  trailActive: false,
  activeSinkIds: [],
  blockedSinkIds: [],
  durableSinkIds: [],
  durablePath: false,
  maxJournalBytes: 1000,
  warnings: [],
};
const snapshot = {
  chainId: 'chain',
  epoch: 2,
  headSeq: 8,
  headHash: 'a'.repeat(64),
  boundarySeq: 9,
  boundaryPrevHash: 'a'.repeat(64),
  pendingCount: 3,
  verification: { fromSeq: 9, throughSeq: 8, bodies: 0, withheld: 0, verifiedAt: 'now' },
  mode: 'export' as const,
  pendingMode: 'none' as 'trail' | 'export' | 'none' | null,
  restorePending: false,
  capacity: { state: 'warning' as const, journalRows: 0, journalBytes: 0 },
  sinks: [
    {
      id: 'archive',
      state: 'disabled' as const,
      progressSeq: 8,
      custodySeq: 5,
      durableAck: true,
      activationSource: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    },
  ],
  ledger: [{ kind: 'gap', count: 3 }],
  endpoint: 'https://private.test/token',
  email: 'private@example.test',
};
it.each([
  { role: 'anonymous', auth: 'none' as const, permissions: [], otherOrg: false, status: 401 },
  { role: 'member', auth: 'session' as const, permissions: [], otherOrg: false, status: 403 },
  {
    role: 'organization admin',
    auth: 'session' as const,
    permissions: ['org:audit:read'],
    otherOrg: false,
    status: 200,
  },
  {
    role: 'other organization admin',
    auth: 'session' as const,
    permissions: ['org:audit:read'],
    otherOrg: true,
    status: 401,
  },
])('status authorization: $role', async ({ auth, permissions, otherOrg, status }) => {
  const f = await fixture(permissions, true, otherOrg);
  if (otherOrg) {
    const foreign = await fixture(permissions, true, true, 'org-b');
    expect((await foreign.request(auth, '/_pb/audit/status')).status).toBe(200);
    expect(foreign.statusRead).toHaveBeenCalledWith(orgContext('org-b'));
    expect(foreign.read).toHaveBeenCalledWith(orgContext('org-b'));
  }
  const response = await f.request(auth, '/_pb/audit/status');
  expect(response.status).toBe(status);
  if (status !== 200) {
    expect(f.statusRead).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  } else {
    const body = await response.json();
    expect(body).toEqual({
      ...Object.fromEntries(
        Object.entries(snapshot).filter(([key]) => !['endpoint', 'email'].includes(key)),
      ),
      mode: 'none',
      pendingMode: 'none',
      sinks: snapshot.sinks,
      policy: 'availability',
      policySource: 'build',
      modeSource: 'env',
      trailActive: false,
      capacity: { ...snapshot.capacity, maxJournalBytes: 1000 },
      health: { status: 'degraded', codes: ['audit.skipped'] },
    });
    expect(f.statusRead).toHaveBeenCalledWith(orgContext('org-a'));
    expect(f.read).toHaveBeenCalledWith(orgContext('org-a'));
  }
  expect(response.headers.get('cache-control')).toContain('no-store');
});
it('returns an unavailable status stub until wired', async () => {
  const f = await fixture(['org:audit:read'], false);
  expect((await f.request('session', '/_pb/audit/status')).status).toBe(404);
  expect(f.statusRead).not.toHaveBeenCalled();
});

it('omits pendingMode when no transition is stored', async () => {
  const f = await fixture();
  f.statusRead.mockResolvedValue({ ...snapshot, mode: 'none', pendingMode: null });
  const response = await f.request('session', '/_pb/audit/status');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ mode: 'none' });
  expect(body).not.toHaveProperty('pendingMode');
});

it('declares an organization boundary for the status route', () => {
  const route = auditStatusRoutes().find((route) => route.path === '/_pb/audit/status');
  expect(route?.boundary).toBe('organization');
});

it('reports the transition target even when the stored and effective modes agree', async () => {
  const f = await fixture();
  f.statusRead.mockResolvedValue({ ...snapshot, mode: 'none', pendingMode: 'trail' });
  const response = await f.request('session', '/_pb/audit/status');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ mode: 'none', pendingMode: 'trail' });
});
