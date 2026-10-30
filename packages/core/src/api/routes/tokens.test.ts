import { describe, expect, it, vi } from 'vitest';
import type { IdempotencyRecord } from '../idempotency.js';
import { SESSION_COOKIE } from '../../auth/cookies.js';
import { sha256Hex } from '../../auth/primitives.js';
import {
  createAuthorizationEngine,
  patValidationGate,
  type EngineTokenAccess,
} from '../../authz/engine.js';
import { PERMISSIONS } from '../../authz/permissions.js';
import { createPersonalTokenService, type PersonalTokenStore } from '../../authz/pat-service.js';
import {
  createServiceTokenService,
  type ServiceTokenStore,
} from '../../authz/service-token-service.js';
import type { ServicePrincipalRecord } from '../../authz/service-principal-service.js';
import { createTokenRevokeService, type RevocableToken } from '../../authz/token-revoke.js';
import type { TokenListItem, TokenReader } from '../../authz/token-read.js';
import { resolveTokenLifetimePolicy } from '../../authz/token-lifetime.js';
import { orgContext } from '../../db/port.js';
import { fixedClock } from '../../ids.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { formatToken } from '../../secrets/token-format.js';
import { hashToken } from '../../secrets/token-hash.js';
import { TOKEN_API_SPECS } from './tokens-schemas.js';
import { tokenRoutes } from './tokens.js';

const ORIGIN = 'https://broker.test';
const PROJECT = '01JA0000000000000000000001';
const OTHER_PROJECT = '01JA0000000000000000000002';
const ORG_PRINCIPAL = '01JA0000000000000000000011';
const PROJECT_PRINCIPAL = '01JA0000000000000000000012';
const OWN_PAT = '01JA0000000000000000000021';
const FOREIGN_PAT = '01JA0000000000000000000022';
const PROJECT_SVC = '01JA0000000000000000000023';
const ORG_SVC = '01JA0000000000000000000024';
const OTHER_PROJECT_SVC = '01JA0000000000000000000025';
const ABSENT = '01JA0000000000000000000099';
const SECRET = 'A'.repeat(43);
const CSRF = 'B'.repeat(43);
const NOW = '2026-10-19T00:00:00.000Z';
const DAY_MS = 86_400_000;
const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
const bearer = formatToken('pat', 'abcdefghijkl', new Uint8Array(32).fill(9));
const clock = fixedClock(NOW);
const inDays = (days: number) => new Date(Date.parse(NOW) + days * DAY_MS).toISOString();

const PERSONAL_BODY = {
  name: 'laptop',
  scope: 'write',
  projectMode: 'selected',
  projectIds: [PROJECT],
};

function item(id: string, extra: Record<string, unknown> = {}): TokenListItem {
  return {
    id,
    kind: 'pat',
    name: 'laptop',
    scope: 'write',
    readOnly: false,
    status: 'active',
    projectMode: 'all',
    projectCount: 0,
    projectId: null,
    userId: 'user-1',
    createdByUserId: null,
    servicePrincipalId: null,
    createdAt: NOW,
    expiresAt: inDays(30),
    lastUsedAt: null,
    revokedAt: null,
    ...extra,
  } as TokenListItem;
}

async function fixture(
  options: {
    permissions?: readonly string[];
    tokenScope?: 'read' | 'full';
    reauth?: boolean;
    protectedHolder?: boolean;
    refuseLoser?: boolean;
    sessionId?: string;
    defaultExpiryDays?: number;
    lifetime?: Parameters<typeof resolveTokenLifetimePolicy>[0];
  } = {},
) {
  const lifetime = resolveTokenLifetimePolicy(options.lifetime);
  const logs: string[] = [];
  const audits: string[] = [];
  const issued: { id: string; plaintext: string; expiresAt: string; projectId?: string | null }[] =
    [];
  const records = new Map<string, IdempotencyRecord>();
  const tokens = new Map<string, RevocableToken & { revoked?: boolean }>([
    [OWN_PAT, { id: OWN_PAT, kind: 'pat', userId: 'user-1', projectId: null, projectMode: 'all' }],
    [
      FOREIGN_PAT,
      { id: FOREIGN_PAT, kind: 'pat', userId: 'user-2', projectId: null, projectMode: 'all' },
    ],
    [
      PROJECT_SVC,
      { id: PROJECT_SVC, kind: 'svc', userId: null, projectId: PROJECT, projectMode: null },
    ],
    [ORG_SVC, { id: ORG_SVC, kind: 'svc', userId: null, projectId: null, projectMode: null }],
    [
      OTHER_PROJECT_SVC,
      {
        id: OTHER_PROJECT_SVC,
        kind: 'svc',
        userId: null,
        projectId: OTHER_PROJECT,
        projectMode: null,
      },
    ],
  ]);
  const principals = new Map<string, ServicePrincipalRecord>([
    [
      ORG_PRINCIPAL,
      {
        id: ORG_PRINCIPAL,
        name: 'org-ci',
        projectId: null,
        createdByUserId: 'user-1',
        status: 'active',
        revision: 1,
        permissions: ['project:packages:read', 'project:packages:write'],
      },
    ],
    [
      PROJECT_PRINCIPAL,
      {
        id: PROJECT_PRINCIPAL,
        name: 'project-ci',
        projectId: PROJECT,
        createdByUserId: 'user-1',
        status: 'active',
        revision: 1,
        permissions: ['project:packages:read', 'project:packages:write'],
      },
    ],
    [
      OTHER_PROJECT_SVC,
      {
        id: OTHER_PROJECT_SVC,
        name: 'other-ci',
        projectId: OTHER_PROJECT,
        createdByUserId: 'user-1',
        status: 'active',
        revision: 1,
        permissions: ['project:packages:read', 'project:packages:write'],
      },
    ],
  ]);
  let sequence = 0;
  const ids = { ulid: () => `01JA${String(++sequence + 100).padStart(22, '0')}` };

  function claimIdempotency(idempotency: IdempotencyRecord | undefined): boolean {
    if (idempotency === undefined) return true;
    const key = `${idempotency.principalKey}|${idempotency.key}`;
    if (records.has(key)) {
      if (options.refuseLoser === true) return false;
      throw new Error('UNIQUE constraint failed: api_idempotency');
    }
    records.set(key, idempotency);
    return true;
  }

  const personalStore: PersonalTokenStore = {
    issuePersonal: vi.fn<PersonalTokenStore['issuePersonal']>(async (_org, _fence, input, mint) => {
      const minted = await mint();
      if (!claimIdempotency(input.idempotency)) return { status: 'refused', reason: 'id_conflict' };
      issued.push({ id: input.id, plaintext: minted.plaintext, expiresAt: input.expiresAt });
      audits.push(input.audit.action);
      return { status: 'issued', id: input.id, plaintext: minted.plaintext };
    }),
  };
  const serviceStore: ServiceTokenStore = {
    issueService: vi.fn<ServiceTokenStore['issueService']>(async (_org, _fence, input, mint) => {
      const minted = await mint();
      if (!claimIdempotency(input.idempotency)) return { status: 'refused', reason: 'id_conflict' };
      issued.push({
        id: input.id,
        plaintext: minted.plaintext,
        expiresAt: input.expiresAt,
        projectId: input.projectId,
      });
      audits.push(input.audit.action);
      return { status: 'issued', id: input.id, plaintext: minted.plaintext };
    }),
  };
  const permissions = options.permissions ?? PERMISSIONS.map((p) => p.name);
  const sessions = {
    isReauthFresh: () => options.reauth ?? true,
    authenticate: vi.fn(
      async () =>
        ({
          session: {
            id: options.sessionId ?? 'session-1',
            userId: 'user-1',
            identityId: null,
            reauthAt: NOW,
          },
          principal: { kind: 'user', id: 'user-1' },
        }) as never,
    ),
  };
  const log = (entry: unknown) => {
    logs.push(JSON.stringify(entry));
  };
  const live = new Set(permissions);
  const authority = {
    livePermissions: async () => live as ReadonlySet<string>,
    guard: () => [] as never,
  };
  const organizations = {
    get: async () =>
      ({
        settings: {
          retentionRemovedUpstreamDays: 30,
          tokenDefaultExpiryDays: options.defaultExpiryDays ?? 30,
          tokenCiReadonlyExpiryDays: 90,
        },
      }) as never,
  };
  const providers = { anchors: async () => [] };
  const personal = createPersonalTokenService({
    lifetime,
    tokens: personalStore,
    sessions,
    organizations,
    providers,
    keyring,
    clock,
    ids,
    log,
  });
  const service = createServiceTokenService({
    lifetime,
    tokens: serviceStore,
    principals: { get: async (_org, id) => principals.get(id) ?? null },
    authority,
    sessions,
    organizations,
    providers,
    keyring,
    clock,
    ids,
    log,
  });
  const revoke = createTokenRevokeService({
    tokens: {
      get: async (_org, id) => tokens.get(id) ?? null,
      revoke: vi.fn(async (_org, _fence, _guard, input) => {
        const row = tokens.get(input.tokenId)!;
        if (row.revoked === true) return { status: 'already_revoked' as const };
        row.revoked = true;
        audits.push(input.audit.action);
        return { status: 'revoked' as const, opId: 'op-1' };
      }),
    },
    authority,
    ownership: { ownPersonalToken: () => [] as never },
    clock,
    ids,
    log,
  });
  const issuePersonal = vi.spyOn(personal, 'issue');
  const issueService = vi.spyOn(service, 'issue');
  const revokeToken = vi.spyOn(revoke, 'revoke');
  const reader = {
    getOwn: vi.fn(),
    getProject: vi.fn(),
    getOrganization: vi.fn(),
    listOwn: vi.fn<TokenReader['listOwn']>(async () => ({
      items: [
        item(OWN_PAT, {
          tokenHash: 'SENTINEL-HASH',
          selector: 'SENTINEL-SELECTOR',
          secretHash: 'SENTINEL-SECRET',
          plaintext: 'SENTINEL-PLAINTEXT',
          pepperVersion: 4242,
        }),
      ],
      next: null,
    })),
    listProject: vi.fn<TokenReader['listProject']>(async () => ({
      items: [item(PROJECT_SVC, { kind: 'svc', projectId: PROJECT, userId: null })],
      next: PROJECT_SVC,
    })),
    listOrganization: vi.fn<TokenReader['listOrganization']>(async () => ({
      items: [item(ORG_SVC, { kind: 'svc', userId: null })],
      next: null,
    })),
  };
  const idempotency = {
    find: vi.fn(
      async (_org: unknown, principalKey: string, key: string) =>
        records.get(`${principalKey}|${key}`) ?? null,
    ),
  };
  const clientIp = vi.fn(() => '203.0.113.7');
  const app = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: tokenRoutes({
      tokens: { personal, service, revoke },
      reader,
      idempotency,
      sessions,
      organizations,
      lifetime,
      clock,
      ids,
      clientIp,
    }),
    ports: { organizations: { get: async () => null }, clock, ids },
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    log,
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async (_org, input) => ({
          session: { id: 'session-1', csrfHash: await sha256Hex(CSRF) },
          user: { id: 'user-1' },
          identity: null,
          protectedHolder: options.protectedHolder ?? true,
          project: input.boundary === 'project' ? { id: PROJECT } : null,
          organizationPermissions: permissions,
          projectPermissions:
            input.boundary === 'project'
              ? ['project:read', ...permissions.filter((p) => p.startsWith('project:'))]
              : [],
        }),
        lookupToken: async (_org, input) =>
          Object.defineProperty(
            {
              token: {
                id: 'token-1',
                kind: 'pat',
                expired: false,
                revoked: false,
                lastUsedAt: null,
                userId: 'user-1',
                servicePrincipalId: null,
                bindingOk: true,
                projectMode: 'all',
                scope: {
                  level: options.tokenScope ?? 'full',
                  readOnly: options.tokenScope === 'read',
                },
              },
              principalStatus: 'active',
              projectVisible: true,
              validation: { kind: 'local', identityId: null, fresh: true, evidenceAt: null },
              project: input.boundary === 'project' ? { id: PROJECT } : null,
              organizationPermissions: permissions,
              projectPermissions: permissions.filter((p) => p.startsWith('project:')),
            },
            'verifier',
            { value: { secretHash: await hashToken(keyring, 1, bearer), pepperVersion: 1 } },
          ) as unknown as EngineTokenAccess,
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: {
        keyring,
        nowMs: () => clock.now().getTime(),
        dispatch: (run) => {
          void run();
        },
        log: () => undefined,
      },
      patValidation: patValidationGate,
      publicOrigin: ORIGIN,
      providerAnchors: async () => [],
    }),
  });
  const request = (
    method: string,
    path: string,
    init: {
      auth?: 'anonymous' | 'token';
      body?: unknown;
      key?: string;
    } = {},
  ) => {
    const headers = new Headers({ origin: ORIGIN, 'content-type': 'application/json' });
    if (init.auth === 'token') headers.set('authorization', `Bearer ${bearer}`);
    else if (init.auth !== 'anonymous') {
      headers.set('cookie', `${SESSION_COOKIE}=${SECRET}`);
      headers.set('x-csrf-token', CSRF);
    }
    if (init.key !== undefined) headers.set('idempotency-key', init.key);
    return app.fetch(
      new Request(ORIGIN + path, {
        method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
  };
  return {
    request,
    audits,
    issued,
    logs,
    records,
    tokens,
    reader,
    idempotency,
    personalStore,
    serviceStore,
    issuePersonal,
    issueService,
    revokeToken,
    clientIp,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function normalized(response: Response) {
  const body = (await response.json()) as { error: { requestId: string } };
  const { requestId, ...error } = body.error;
  expect(requestId).toEqual(expect.any(String));
  return {
    status: response.status,
    headers: [...response.headers].filter(([key]) => key !== 'x-request-id'),
    body: { error },
  };
}

function noServiceCalls(f: Fixture) {
  for (const method of [f.issuePersonal, f.issueService, f.revokeToken]) {
    expect(method).not.toHaveBeenCalled();
  }
}

function issueCalls(f: Fixture): number {
  return (
    f.issuePersonal.mock.calls.length +
    f.issueService.mock.calls.length +
    vi.mocked(f.personalStore.issuePersonal).mock.calls.length +
    vi.mocked(f.serviceStore.issueService).mock.calls.length
  );
}

const ISSUE_ROUTES = [
  { name: 'personal', path: '/_pb/me/tokens', body: PERSONAL_BODY, permission: null },
  {
    name: 'project',
    path: '/_pb/projects/demo/tokens',
    body: { servicePrincipalId: PROJECT_PRINCIPAL, name: 'ci', scope: 'write' },
    permission: 'project:tokens:create',
  },
  {
    name: 'organization',
    path: '/_pb/tokens',
    body: { servicePrincipalId: ORG_PRINCIPAL, name: 'ci', scope: 'write' },
    permission: 'org:service-principals:write',
  },
] as const;

const REVOKE_ROUTES = [
  { name: 'own', path: `/_pb/me/tokens/${OWN_PAT}`, id: OWN_PAT },
  { name: 'project', path: `/_pb/projects/demo/tokens/${PROJECT_SVC}`, id: PROJECT_SVC },
  { name: 'organization', path: `/_pb/tokens/${ORG_SVC}`, id: ORG_SVC },
] as const;

const LIST_ROUTES = [
  { name: 'own', path: '/_pb/me/tokens', permission: null },
  { name: 'project', path: '/_pb/projects/demo/tokens', permission: 'project:tokens:read' },
  { name: 'organization', path: '/_pb/tokens', permission: 'org:tokens:read' },
] as const;

describe('token route table', () => {
  it('declares each operation once with a distinct id', () => {
    const ids = TOKEN_API_SPECS.map((spec) => spec.api.operationId);
    expect(ids.sort()).toEqual(
      [
        'createOrganizationToken',
        'createPersonalToken',
        'createProjectToken',
        'listMyTokens',
        'listProjectTokens',
        'listTokens',
        'revokeMyToken',
        'revokeProjectToken',
        'revokeToken',
      ].sort(),
    );
  });

  it('pins the token-usable write set so a new entry forces a design decision', () => {
    const writable = PERMISSIONS.filter(
      (info) => !info.sessionOnly && !info.name.endsWith(':read'),
    ).map((info) => info.name);
    expect(writable).toEqual([
      'org:packages:publish',
      'org:import:write',
      'project:packages:write',
    ]);
  });
});

describe.each(ISSUE_ROUTES)('POST $path', (route) => {
  it('answers 201 with the id and the plaintext once, uncached', async () => {
    const f = await fixture();
    const response = await f.request('POST', route.path, { body: route.body });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['id', 'token']);
    expect(f.issued).toHaveLength(1);
    expect(body).toEqual({ id: f.issued[0]!.id, token: f.issued[0]!.plaintext });
  });

  it('never leaves the plaintext in logs, audit rows or the stored idempotency record', async () => {
    const f = await fixture();
    const response = await f.request('POST', route.path, { body: route.body, key: 'key-1' });
    expect(response.status).toBe(201);
    const { plaintext } = f.issued[0]!;
    expect(f.logs.join('\n')).not.toContain(plaintext);
    expect(f.audits.join('\n')).not.toContain(plaintext);
    expect(JSON.stringify([...f.records.values()])).not.toContain(plaintext);
  });

  it.each(['read', 'full'] as const)('denies a %s-scope token credential', async (tokenScope) => {
    const f = await fixture({ tokenScope });
    const response = await f.request('POST', route.path, { auth: 'token', body: route.body });
    expect(response.status).toBe(403);
    noServiceCalls(f);
  });

  it('denies anonymous callers', async () => {
    const f = await fixture();
    expect(
      (await f.request('POST', route.path, { auth: 'anonymous', body: route.body })).status,
    ).toBe(401);
    noServiceCalls(f);
  });

  it('answers reauth_required when the session is not freshly reauthenticated', async () => {
    const f = await fixture({ reauth: false });
    const response = await f.request('POST', route.path, { body: route.body });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'reauth_required',
    );
    expect(f.issued).toEqual([]);
  });

  it('stores the default expiry when expiresAt is omitted', async () => {
    const f = await fixture();
    expect((await f.request('POST', route.path, { body: route.body })).status).toBe(201);
    expect(f.issued[0]!.expiresAt).toBe(inDays(30));
  });

  it('accepts an expiry 300 days ahead without a schema day cap', async () => {
    const f = await fixture();
    const response = await f.request('POST', route.path, {
      body: { ...route.body, expiresAt: inDays(300) },
    });
    expect(response.status).toBe(201);
    expect(f.issued[0]!.expiresAt).toBe(inDays(300));
  });

  it('refuses expiresAt together with lifetimeDays', async () => {
    const f = await fixture();
    const response = await f.request('POST', route.path, {
      body: { ...route.body, expiresAt: inDays(10), lifetimeDays: 10 },
    });
    expect(response.status).toBe(400);
    expect(f.issued).toEqual([]);
  });

  it('refuses an explicit null expiry', async () => {
    const f = await fixture();
    const response = await f.request('POST', route.path, {
      body: { ...route.body, expiresAt: null },
    });
    expect(response.status).toBe(400);
    expect(f.issued).toEqual([]);
  });

  it('refuses a non-canonical expiry', async () => {
    const f = await fixture();
    const response = await f.request('POST', route.path, {
      body: { ...route.body, expiresAt: '2027-01-01' },
    });
    expect(response.status).toBe(400);
    expect(f.issued).toEqual([]);
  });

  it('refuses an unknown body field', async () => {
    const f = await fixture();
    const response = await f.request('POST', route.path, {
      body: { ...route.body, tokenHash: 'x' },
    });
    expect(response.status).toBe(400);
    expect(f.issued).toEqual([]);
  });

  it('refuses a malformed idempotency key', async () => {
    const f = await fixture();
    const response = await f.request('POST', route.path, { body: route.body, key: 'bad key!' });
    expect(response.status).toBe(400);
    expect(f.issued).toEqual([]);
  });

  it('replays a repeated key as already_issued with the id and without the plaintext', async () => {
    const f = await fixture();
    const first = await f.request('POST', route.path, { body: route.body, key: 'key-1' });
    expect(first.status).toBe(201);
    const second = await f.request('POST', route.path, { body: route.body, key: 'key-1' });
    expect(second.status).toBe(409);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(second.headers.get('cache-control')).toBe('no-store');
    const text = await second.text();
    const body = JSON.parse(text) as { error: { code: string }; id: string };
    expect(body.error.code).toBe('already_issued');
    expect(body.id).toBe(f.issued[0]!.id);
    expect(text).not.toContain(f.issued[0]!.plaintext);
    expect(f.issued).toHaveLength(1);
    expect(f.audits).toEqual(['token.issue']);
    expect(issueCalls(f)).toBe(2);
  });

  it('answers idempotency_mismatch for the same key with another body', async () => {
    const f = await fixture();
    expect((await f.request('POST', route.path, { body: route.body, key: 'key-1' })).status).toBe(
      201,
    );
    const response = await f.request('POST', route.path, {
      body: { ...route.body, name: 'other' },
      key: 'key-1',
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'idempotency_mismatch',
    );
    expect(f.issued).toHaveLength(1);
    expect(issueCalls(f)).toBe(2);
  });

  it('settles two concurrent requests with one key into one row and one replay', async () => {
    const f = await fixture();
    const responses = await Promise.all([
      f.request('POST', route.path, { body: route.body, key: 'race' }),
      f.request('POST', route.path, { body: route.body, key: 'race' }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = responses.find((r) => r.status === 409)!;
    const winner = responses.find((r) => r.status === 201)!;
    const loserText = await loser.text();
    const winnerBody = (await winner.json()) as { id: string; token: string };
    expect((JSON.parse(loserText) as { error: { code: string } }).error.code).toBe(
      'already_issued',
    );
    expect(loserText).not.toContain(winnerBody.token);
    expect(f.records.size).toBe(1);
    expect(f.audits).toEqual(['token.issue']);
  });

  it('settles a race whose loser gets a refusal result into the stored replay', async () => {
    const f = await fixture({ refuseLoser: true });
    const responses = await Promise.all([
      f.request('POST', route.path, { body: route.body, key: 'race' }),
      f.request('POST', route.path, { body: route.body, key: 'race' }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = responses.find((r) => r.status === 409)!;
    expect(loser.headers.get('idempotent-replayed')).toBe('true');
    expect(((await loser.json()) as { error: { code: string } }).error.code).toBe('already_issued');
    expect(f.audits).toEqual(['token.issue']);
  });

  it('answers 401 without a service call when the session changed under the request', async () => {
    const f = await fixture({ sessionId: 'session-2' });
    expect((await f.request('POST', route.path, { body: route.body })).status).toBe(401);
    expect(issueCalls(f)).toBe(0);
    expect(f.issued).toEqual([]);
  });

  if (route.permission !== null) {
    it('denies a visible boundary without the issue permission', async () => {
      const f = await fixture({ permissions: ['org:read', 'project:read'] });
      expect((await f.request('POST', route.path, { body: route.body })).status).toBe(403);
      noServiceCalls(f);
    });
  }
});

describe('POST /_pb/me/tokens', () => {
  it('forwards the validated body, the session fence and the audit context', async () => {
    const f = await fixture();
    const response = await f.request('POST', '/_pb/me/tokens', {
      body: { ...PERSONAL_BODY, lifetimeDays: 20 },
    });
    expect(response.status).toBe(201);
    const call = f.issuePersonal.mock.calls[0]!;
    expect(call[0]).toEqual(orgContext('org-1'));
    expect(call[2]).toEqual({ userId: 'user-1', sessionId: 'session-1', expected: {} });
    expect(call[3]).toEqual({ ...PERSONAL_BODY, lifetimeDays: 20 });
    expect(call[4]).toEqual({
      audit: {
        opId: expect.any(String),
        requestId: response.headers.get('x-request-id'),
        sourceIp: '203.0.113.7',
        tokenSelector: null,
      },
    });
  });

  it('answers 400 for an invalid project selection', async () => {
    const f = await fixture();
    const response = await f.request('POST', '/_pb/me/tokens', {
      body: { ...PERSONAL_BODY, projectMode: 'all' },
    });
    expect(response.status).toBe(400);
    expect(f.issued).toEqual([]);
  });
});

describe('POST /_pb/projects/:project/tokens', () => {
  it('binds the token to the route project', async () => {
    const f = await fixture();
    const response = await f.request('POST', '/_pb/projects/demo/tokens', {
      body: { servicePrincipalId: PROJECT_PRINCIPAL, name: 'ci', scope: 'write' },
    });
    expect(response.status).toBe(201);
    expect(f.issueService.mock.calls[0]![4]).toMatchObject({ routeProjectId: PROJECT });
    expect(f.issued[0]!.projectId).toBe(PROJECT);
  });

  it('hides a principal of another project like an absent id', async () => {
    const f = await fixture();
    const foreign = await f.request('POST', '/_pb/projects/demo/tokens', {
      body: { servicePrincipalId: OTHER_PROJECT_SVC, name: 'ci', scope: 'write' },
    });
    const absent = await f.request('POST', '/_pb/projects/demo/tokens', {
      body: { servicePrincipalId: ABSENT, name: 'ci', scope: 'write' },
    });
    expect(foreign.status).toBe(404);
    expect(await normalized(foreign)).toEqual(await normalized(absent));
    expect(f.issued).toEqual([]);
  });

  it('hides an organization principal like an absent id', async () => {
    const f = await fixture();
    const wrong = await f.request('POST', '/_pb/projects/demo/tokens', {
      body: { servicePrincipalId: ORG_PRINCIPAL, name: 'ci', scope: 'write' },
    });
    const absent = await f.request('POST', '/_pb/projects/demo/tokens', {
      body: { servicePrincipalId: ABSENT, name: 'ci', scope: 'write' },
    });
    expect(await normalized(wrong)).toEqual(await normalized(absent));
  });
});

describe('POST /_pb/tokens', () => {
  it('issues for an organization-level principal with no route project', async () => {
    const f = await fixture();
    const response = await f.request('POST', '/_pb/tokens', {
      body: { servicePrincipalId: ORG_PRINCIPAL, name: 'ci', scope: 'write' },
    });
    expect(response.status).toBe(201);
    expect(f.issueService.mock.calls[0]![4]).toMatchObject({ routeProjectId: null });
    expect(f.issued[0]!.projectId).toBeNull();
  });

  it('hides a project principal like an absent id', async () => {
    const f = await fixture();
    const project = await f.request('POST', '/_pb/tokens', {
      body: { servicePrincipalId: PROJECT_PRINCIPAL, name: 'ci', scope: 'write' },
    });
    const absent = await f.request('POST', '/_pb/tokens', {
      body: { servicePrincipalId: ABSENT, name: 'ci', scope: 'write' },
    });
    expect(project.status).toBe(404);
    expect(await normalized(project)).toEqual(await normalized(absent));
  });
});

describe.each(LIST_ROUTES)('GET $path', (route) => {
  it('lists with the lifetime policy next to items and next', async () => {
    const f = await fixture();
    const response = await f.request('GET', route.path);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['items', 'lifetime', 'next']);
    expect(body['lifetime']).toEqual({
      personal: { maxDays: 365, defaultDays: 30 },
      service: { maxDays: 365, defaultDays: 30 },
    });
  });

  it('caps defaultDays at the maximum lifetime', async () => {
    const f = await fixture({ lifetime: { maxLifetimeDays: { personal: 14, service: 20 } } });
    const body = (await (await f.request('GET', route.path)).json()) as {
      lifetime: unknown;
    };
    expect(body.lifetime).toEqual({
      personal: { maxDays: 14, defaultDays: 14 },
      service: { maxDays: 20, defaultDays: 20 },
    });
  });

  it('never exposes a hash, selector or plaintext column', async () => {
    const f = await fixture();
    const leaking = {
      items: [
        item(OWN_PAT, {
          tokenHash: 'SENTINEL-HASH',
          selector: 'SENTINEL-SELECTOR',
          secretHash: 'SENTINEL-SECRET',
          plaintext: 'SENTINEL-PLAINTEXT',
          pepperVersion: 4242,
          email: 'person@example.test',
        }),
      ],
      next: null,
    };
    f.reader.listOwn.mockResolvedValue(leaking);
    f.reader.listProject.mockResolvedValue(leaking);
    f.reader.listOrganization.mockResolvedValue(leaking);
    const text = await (await f.request('GET', route.path)).text();
    expect(text).not.toContain('SENTINEL');
    expect(text).not.toContain('4242');
    expect(text).not.toContain('example.test');
    expect(text).toContain(OWN_PAT);
  });

  it('denies a token credential', async () => {
    const f = await fixture();
    expect((await f.request('GET', route.path, { auth: 'token' })).status).toBe(403);
    expect(f.reader.listOwn).not.toHaveBeenCalled();
    expect(f.reader.listProject).not.toHaveBeenCalled();
    expect(f.reader.listOrganization).not.toHaveBeenCalled();
  });

  it('denies anonymous callers', async () => {
    const f = await fixture();
    expect((await f.request('GET', route.path, { auth: 'anonymous' })).status).toBe(401);
  });

  it('rejects a limit above 100', async () => {
    const f = await fixture();
    expect((await f.request('GET', `${route.path}?limit=101`)).status).toBe(400);
  });

  it('rejects a malformed cursor', async () => {
    const f = await fixture();
    expect((await f.request('GET', `${route.path}?after=nope`)).status).toBe(400);
  });

  if (route.permission !== null) {
    it('denies a visible boundary without the read permission', async () => {
      const f = await fixture({ permissions: ['org:read', 'project:read'] });
      expect((await f.request('GET', route.path)).status).toBe(403);
    });
  }
});

describe('list lifetime advertising', () => {
  it.each([0, -3, 1.5, Number.NaN])(
    'answers unavailable for a configured default of %s',
    async (days) => {
      const f = await fixture({ defaultExpiryDays: days });
      for (const route of LIST_ROUTES) {
        const response = await f.request('GET', route.path);
        expect(response.status).toBe(503);
      }
    },
  );
});

describe('POST /_pb/me/tokens project bound', () => {
  it('rejects more than 200 project ids at the schema', async () => {
    const f = await fixture();
    const projectIds = Array.from({ length: 201 }, (_, i) => `p${i}`);
    const response = await f.request('POST', '/_pb/me/tokens', {
      body: { ...PERSONAL_BODY, projectIds },
    });
    expect(response.status).toBe(400);
    expect(f.issuePersonal).not.toHaveBeenCalled();
  });
});

describe('token list reads', () => {
  it('reads the caller own tokens with the page, cursor and database clock', async () => {
    const f = await fixture();
    await f.request('GET', `/_pb/me/tokens?limit=5&after=${OWN_PAT}&status=active`);
    expect(f.reader.listOwn).toHaveBeenCalledExactlyOnceWith(orgContext('org-1'), 'user-1', {
      after: OWN_PAT,
      limit: 5,
      status: 'active',
      now: NOW,
    });
  });

  it('reads the route project tokens', async () => {
    const f = await fixture();
    const response = await f.request('GET', '/_pb/projects/demo/tokens');
    expect(f.reader.listProject).toHaveBeenCalledExactlyOnceWith(orgContext('org-1'), PROJECT, {
      after: null,
      limit: 50,
      now: NOW,
    });
    expect(((await response.json()) as { next: string }).next).toBe(PROJECT_SVC);
  });

  it('filters organization tokens by kind and status', async () => {
    const f = await fixture();
    await f.request('GET', '/_pb/tokens?kind=svc&status=expired');
    expect(f.reader.listOrganization).toHaveBeenCalledExactlyOnceWith(orgContext('org-1'), {
      after: null,
      limit: 50,
      status: 'expired',
      kind: 'svc',
      now: NOW,
    });
  });
});

describe.each(REVOKE_ROUTES)('DELETE $path', (route) => {
  it('answers 204 and stages one audit event', async () => {
    const f = await fixture();
    const response = await f.request('DELETE', route.path);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(f.audits).toEqual(['token.revoke']);
  });

  it('answers 204 again for a revoked token and stages no second audit event', async () => {
    const f = await fixture();
    expect((await f.request('DELETE', route.path)).status).toBe(204);
    expect((await f.request('DELETE', route.path)).status).toBe(204);
    expect(f.audits).toEqual(['token.revoke']);
  });

  it.each(['read', 'full'] as const)('denies a %s-scope token credential', async (tokenScope) => {
    const f = await fixture({ tokenScope });
    expect((await f.request('DELETE', route.path, { auth: 'token' })).status).toBe(403);
    noServiceCalls(f);
    expect(f.tokens.get(route.id)).not.toHaveProperty('revoked');
  });

  it('denies anonymous callers', async () => {
    const f = await fixture();
    expect((await f.request('DELETE', route.path, { auth: 'anonymous' })).status).toBe(401);
    noServiceCalls(f);
  });

  it('rejects a non-ULID token id before the service', async () => {
    const f = await fixture();
    const response = await f.request('DELETE', route.path.replace(route.id, 'nope'));
    expect(response.status).toBe(400);
    noServiceCalls(f);
  });

  it('hides an absent token behind the uniform 404', async () => {
    const f = await fixture();
    const response = await f.request('DELETE', route.path.replace(route.id, ABSENT));
    expect(response.status).toBe(404);
    expect(f.audits).toEqual([]);
  });
});

describe('revoke ownership', () => {
  it("hides another user's personal token on the own route and leaves it active", async () => {
    const f = await fixture();
    const foreign = await f.request('DELETE', `/_pb/me/tokens/${FOREIGN_PAT}`);
    const absent = await f.request('DELETE', `/_pb/me/tokens/${ABSENT}`);
    expect(foreign.status).toBe(404);
    expect(await normalized(foreign)).toEqual(await normalized(absent));
    expect(f.tokens.get(FOREIGN_PAT)).not.toHaveProperty('revoked');
    expect(f.audits).toEqual([]);
  });

  it('hides a service token on the own route', async () => {
    const f = await fixture();
    expect((await f.request('DELETE', `/_pb/me/tokens/${ORG_SVC}`)).status).toBe(404);
    expect(f.tokens.get(ORG_SVC)).not.toHaveProperty('revoked');
  });

  it('hides a token of another project on the project route', async () => {
    const f = await fixture();
    const other = await f.request('DELETE', `/_pb/projects/demo/tokens/${OTHER_PROJECT_SVC}`);
    const absent = await f.request('DELETE', `/_pb/projects/demo/tokens/${ABSENT}`);
    expect(other.status).toBe(404);
    expect(await normalized(other)).toEqual(await normalized(absent));
    expect(f.tokens.get(OTHER_PROJECT_SVC)).not.toHaveProperty('revoked');
  });

  it('keeps the route project in the call', async () => {
    const f = await fixture();
    await f.request('DELETE', `/_pb/projects/demo/tokens/${PROJECT_SVC}`);
    expect(f.revokeToken.mock.calls[0]![3]).toEqual({
      via: 'project',
      tokenId: PROJECT_SVC,
      routeProjectId: PROJECT,
    });
  });

  it('revokes through the organization route for another user', async () => {
    const f = await fixture();
    expect((await f.request('DELETE', `/_pb/tokens/${FOREIGN_PAT}`)).status).toBe(204);
    expect(f.revokeToken.mock.calls[0]![3]).toEqual({
      via: 'organization',
      tokenId: FOREIGN_PAT,
      routeProjectId: null,
    });
  });
});
