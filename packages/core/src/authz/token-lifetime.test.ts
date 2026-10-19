import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedSession } from '../auth/session.js';
import type { Organization } from '../db/organization.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { createKeyring } from '../secrets/keyring.js';
import { mutationFence, type AuthenticatedActor } from './fence.js';
import {
  createPersonalTokenService,
  type PersonalTokenIssueInput,
  type PersonalTokenStoreInput,
} from './pat-service.js';
import {
  createServiceTokenService,
  type ServiceTokenIssueInput,
  type ServiceTokenStoreInput,
} from './service-token-service.js';
import {
  defaultExpiry,
  lifetimeExpiry,
  resolveTokenLifetimePolicy,
  TokenConfigError,
  type TokenLifetimeInput,
} from './token-lifetime.js';

const NOW = '2026-10-19T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const DAY = 86_400_000;
const inDays = (days: number, extra = 0) => new Date(NOW_MS + days * DAY + extra).toISOString();

describe('token lifetime configuration', () => {
  it.each([undefined, {}])('defaults %j to frozen 365 day maxima', (input) => {
    const policy = resolveTokenLifetimePolicy(input);
    expect(policy).toEqual({ personal: { maxDays: 365 }, service: { maxDays: 365 } });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.personal)).toBe(true);
    expect(Object.isFrozen(policy.service)).toBe(true);
  });

  it('accepts both range boundaries', () => {
    expect(resolveTokenLifetimePolicy({ maxLifetimeDays: { personal: 1, service: 1 } })).toEqual({
      personal: { maxDays: 1 },
      service: { maxDays: 1 },
    });
    expect(
      resolveTokenLifetimePolicy({ maxLifetimeDays: { personal: 365, service: 3650 } }),
    ).toEqual({
      personal: { maxDays: 365 },
      service: { maxDays: 3650 },
    });
  });

  it.each([
    [
      'personal zero',
      { maxLifetimeDays: { personal: 0 } },
      'tokens.maxLifetimeDays.personal',
      '1..365',
    ],
    [
      'personal above ceiling',
      { maxLifetimeDays: { personal: 366 } },
      'tokens.maxLifetimeDays.personal',
      '1..365',
    ],
    [
      'service above ceiling',
      { maxLifetimeDays: { service: 3651 } },
      'tokens.maxLifetimeDays.service',
      '1..3650',
    ],
    [
      'service fraction',
      { maxLifetimeDays: { service: 1.5 } },
      'tokens.maxLifetimeDays.service',
      '1..3650',
    ],
    [
      'service string',
      { maxLifetimeDays: { service: '30' } },
      'tokens.maxLifetimeDays.service',
      '1..3650',
    ],
    [
      'personal null',
      { maxLifetimeDays: { personal: null } },
      'tokens.maxLifetimeDays.personal',
      '1..365',
    ],
    ['unknown maximum', { maxLifetimeDays: { cst: 1 } }, 'tokens.maxLifetimeDays.cst', '1..3650'],
    ['unknown root key', { cst: 1 }, 'tokens.cst', '1..365'],
    ['null input', null, 'tokens', '1..365'],
    ['null maxima', { maxLifetimeDays: null }, 'tokens.maxLifetimeDays', '1..365'],
    [
      'service zero',
      { maxLifetimeDays: { service: 0 } },
      'tokens.maxLifetimeDays.service',
      '1..3650',
    ],
    [
      'unsafe integer',
      { maxLifetimeDays: { service: Number.MAX_SAFE_INTEGER + 1 } },
      'tokens.maxLifetimeDays.service',
      '1..3650',
    ],
  ])('rejects %s without disclosing the value', (_name, input, path, range) => {
    let caught: unknown;
    try {
      resolveTokenLifetimePolicy(input as TokenLifetimeInput);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TokenConfigError);
    const error = caught as TokenConfigError;
    expect(error.name).toBe('TokenConfigError');
    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toContain(path);
    expect(error.problems[0]).toContain(range);
    expect(JSON.stringify(error.problems)).not.toContain('30');
  });

  it('collects every problem', () => {
    try {
      resolveTokenLifetimePolicy({
        cst: true,
        maxLifetimeDays: { personal: 0, service: 3651, cst: 1 },
      } as TokenLifetimeInput);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TokenConfigError);
      expect((error as TokenConfigError).problems).toHaveLength(4);
    }
  });
});

describe('expiry arithmetic', () => {
  it('uses the organization default below the maximum', () => {
    expect(defaultExpiry(NOW_MS, 365, 90)).toBe(NOW_MS + 90 * DAY);
  });
  it.each([365, 500])('subtracts one minute when default %s reaches the maximum', (days) => {
    expect(defaultExpiry(NOW_MS, 365, days)).toBe(NOW_MS + 365 * DAY - 60_000);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses unusable default %s',
    (days) => {
      expect(defaultExpiry(NOW_MS, 365, days)).toBeNull();
    },
  );
  it('computes a selected lifetime below the maximum', () => {
    expect(lifetimeExpiry(NOW_MS, 365, 30)).toBe(NOW_MS + 30 * DAY);
  });
  it('subtracts one minute at the selected maximum', () => {
    expect(lifetimeExpiry(NOW_MS, 365, 365)).toBe(NOW_MS + 365 * DAY - 60_000);
  });
  it.each([0, -1, 1.5, 366, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses unusable selected lifetime %s',
    (days) => {
      expect(lifetimeExpiry(NOW_MS, 365, days)).toBeNull();
    },
  );
});

const ctx = orgContext('org-a');
const authenticated = {
  session: { id: 'session-1', userId: 'user-1', identityId: null },
  principal: { kind: 'user', id: 'user-1' },
} as unknown as AuthenticatedSession;
const fence = mutationFence(
  { userId: 'user-1', sessionId: 'session-1' } as unknown as AuthenticatedActor,
  {},
);
const call = {
  audit: {
    opId: '01K00000000000000000000001',
    requestId: '01K00000000000000000000002',
    sourceIp: null,
    tokenSelector: null,
  },
};
const permissions = [
  'project:tokens:create',
  'project:packages:read',
  'project:packages:write',
  'project:read',
];

function rig(
  kind: 'personal' | 'service',
  options: { maxDays?: number; days?: number; omitPolicy?: boolean } = {},
) {
  const stored: (PersonalTokenStoreInput | ServiceTokenStoreInput)[] = [];
  const store = vi.fn(
    async (
      _ctx: unknown,
      _fence: unknown,
      input: PersonalTokenStoreInput | ServiceTokenStoreInput,
    ) => {
      stored.push(input);
      return { status: 'issued' as const, id: input.id, plaintext: 'unused' };
    },
  );
  const get = vi.fn(async (): Promise<Organization> => ({
    id: ctx.orgId,
    slug: 'a',
    name: 'A',
    createdAt: NOW,
    updatedAt: NOW,
    settings: {
      retentionRemovedUpstreamDays: 30,
      tokenDefaultExpiryDays: options.days ?? 90,
      get tokenCiReadonlyExpiryDays(): number {
        throw new Error('obsolete setting read');
      },
    },
  }));
  const anchors = vi.fn(async () => []);
  const principalGet = vi.fn(async () => ({
    id: 'sp-1',
    name: 'ci',
    projectId: 'project-1',
    createdByUserId: 'user-1',
    status: 'active' as const,
    revision: 1,
    permissions,
  }));
  const livePermissions = vi.fn(async () => new Set(permissions));
  const log = vi.fn();
  const deps = {
    sessions: { isReauthFresh: () => true },
    organizations: { get },
    providers: { anchors },
    keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]),
    clock: fixedClock(NOW),
    ids: { ulid: () => 'token-1' },
    log,
    ...(options.omitPolicy
      ? {}
      : {
          lifetime: resolveTokenLifetimePolicy({
            maxLifetimeDays: { [kind]: options.maxDays ?? 365 },
          }),
        }),
  };
  const personal = createPersonalTokenService({ ...deps, tokens: { issuePersonal: store } });
  const service = createServiceTokenService({
    ...deps,
    tokens: { issueService: store },
    principals: { get: principalGet },
    authority: { livePermissions },
  });
  const issue = (input: Partial<PersonalTokenIssueInput & ServiceTokenIssueInput> = {}) =>
    kind === 'personal'
      ? personal.issue(
          ctx,
          authenticated,
          fence,
          { name: 'test', scope: 'read', projectMode: 'all', projectIds: [], ...input },
          call,
        )
      : service.issue(
          ctx,
          authenticated,
          {
            kind: 'organization',
            userId: 'user-1',
            permissions: new Set(),
            isOrganizationAdmin: false,
          },
          fence,
          {
            name: 'test',
            scope: 'read',
            routeProjectId: 'project-1',
            servicePrincipalId: 'sp-1',
            ...input,
          },
          call,
        );
  const noRepositories = () => {
    for (const spy of [store, get, anchors, principalGet, livePermissions])
      expect(spy).not.toHaveBeenCalled();
  };
  return { stored, store, issue, log, noRepositories };
}

describe.each(['personal', 'service'] as const)('%s token lifetime', (kind) => {
  it('accepts an explicit maximum independent of the organization default and obsolete CI setting', async () => {
    const r = rig(kind);
    expect((await r.issue({ expiresAt: inDays(365) })).ok).toBe(true);
    expect(r.stored[0]).toMatchObject({ expiresAt: inDays(365), maxLifetimeDays: 365 });
    expect(r.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'token.issued', expiresAt: inDays(365), defaulted: false }),
    );
  });
  it('rejects one millisecond beyond the maximum before all repositories', async () => {
    const r = rig(kind);
    expect(await r.issue({ expiresAt: inDays(365, 1) })).toEqual({
      ok: false,
      error: 'invalid_expiry',
    });
    r.noRepositories();
  });
  it.each([
    ['null', null],
    ['empty', ''],
    ['undefined property', undefined],
    ['past', inDays(-1)],
    ['now', NOW],
    ['noncanonical', '2026-10-20T12:00:00Z'],
  ])('rejects %s expiry before all repositories', async (_name, expiresAt) => {
    const r = rig(kind);
    expect(await r.issue({ expiresAt: expiresAt as never })).toEqual({
      ok: false,
      error: 'invalid_expiry',
    });
    r.noRepositories();
  });
  it('defaults an omitted expiry to 90 days', async () => {
    const r = rig(kind);
    expect((await r.issue()).ok).toBe(true);
    expect(r.stored[0]).toMatchObject({ expiresAt: inDays(90), maxLifetimeDays: 365 });
    expect(r.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'token.issued', expiresAt: inDays(90), defaulted: true }),
    );
    expect(JSON.parse(r.stored[0]!.audit.payloadJson).changes).toMatchObject({
      expires_at: { new: inDays(90) },
    });
  });
  it('caps the organization default with a one minute margin', async () => {
    const r = rig(kind, { days: 500 });
    expect((await r.issue()).ok).toBe(true);
    expect(r.stored[0]?.expiresAt).toBe(inDays(365, -60_000));
  });
  it('denies an omitted expiry with an unusable organization default', async () => {
    const r = rig(kind, { days: 0 });
    expect(await r.issue()).toEqual({ ok: false, error: 'forbidden' });
    expect(r.store).not.toHaveBeenCalled();
  });
  it('stores a chosen lifetime at the maximum with the margin', async () => {
    const r = rig(kind);
    expect((await r.issue({ lifetimeDays: 365 })).ok).toBe(true);
    expect(r.stored[0]).toMatchObject({ expiresAt: inDays(365, -60_000), maxLifetimeDays: 365 });
    expect(r.log).toHaveBeenCalledWith(expect.objectContaining({ defaulted: false }));
  });
  it.each([366, 0, -1, 1.5, '30', null])(
    'rejects invalid lifetimeDays %j before repositories',
    async (days) => {
      const r = rig(kind);
      expect(await r.issue({ lifetimeDays: days as never })).toEqual({
        ok: false,
        error: 'invalid_expiry',
      });
      r.noRepositories();
    },
  );
  it('rejects both expiry inputs before repositories', async () => {
    const r = rig(kind);
    expect(await r.issue({ lifetimeDays: 30, expiresAt: inDays(30) })).toEqual({
      ok: false,
      error: 'invalid_expiry',
    });
    r.noRepositories();
  });
  it('uses the default policy when the dependency is absent', async () => {
    const r = rig(kind, { omitPolicy: true });
    expect((await r.issue({ expiresAt: inDays(365) })).ok).toBe(true);
  });
  it('rejects beyond the default policy when the dependency is absent', async () => {
    const r = rig(kind, { omitPolicy: true });
    expect(await r.issue({ expiresAt: inDays(365, 1) })).toEqual({
      ok: false,
      error: 'invalid_expiry',
    });
    r.noRepositories();
  });
});

it('applies a personal operator maximum of 30 days', async () => {
  const r = rig('personal', { maxDays: 30 });
  expect(await r.issue({ expiresAt: inDays(31) })).toEqual({ ok: false, error: 'invalid_expiry' });
  r.noRepositories();
});
it('passes a custom personal maximum to the store', async () => {
  const r = rig('personal', { maxDays: 30 });
  expect((await r.issue({ expiresAt: inDays(30) })).ok).toBe(true);
  expect(r.stored[0]?.maxLifetimeDays).toBe(30);
});
it('allows a 400 day read service token and passes its maximum to the store', async () => {
  const r = rig('service', { maxDays: 400 });
  expect((await r.issue({ expiresAt: inDays(400) })).ok).toBe(true);
  expect(r.stored[0]?.maxLifetimeDays).toBe(400);
});
it.each(['write', 'full'] as const)('allows a 365 day %s service token', async (scope) => {
  const r = rig('service');
  expect((await r.issue({ scope, expiresAt: inDays(365) })).ok).toBe(true);
});
it.each(['read', 'write', 'full'] as const)(
  'refuses a %s service token above a custom maximum',
  async (scope) => {
    const r = rig('service', { maxDays: 400 });
    expect(await r.issue({ scope, expiresAt: inDays(400, 1) })).toEqual({
      ok: false,
      error: 'invalid_expiry',
    });
    r.noRepositories();
  },
);
