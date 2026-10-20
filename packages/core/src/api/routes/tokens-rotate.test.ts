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
import {
  createServiceTokenService,
  type ServiceTokenStore,
  type ServiceTokenRotateStoreInput,
} from '../../authz/service-token-service.js';
import type { TokenListItem, TokenReader } from '../../authz/token-read.js';
import { resolveTokenLifetimePolicy } from '../../authz/token-lifetime.js';
import { orgContext } from '../../db/port.js';
import { fixedClock } from '../../ids.js';
import { generateOpenApi } from '../openapi.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { formatToken } from '../../secrets/token-format.js';
import { hashToken } from '../../secrets/token-hash.js';
import { tokenRoutes } from './tokens.js';
import { TOKEN_API_SPECS, TOKEN_DETAIL_API_SPECS } from './tokens-schemas.js';

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

async function fixture(options: { permissions?: readonly string[]; reauth?: boolean } = {}) {
  const permissions = options.permissions ?? PERMISSIONS.map((p) => p.name);
  const lifetime = resolveTokenLifetimePolicy({});
  const logs: string[] = [];
  const audits: ServiceTokenRotateStoreInput[] = [];
  const records = new Map<string, IdempotencyRecord>();
  const metadata = new Map<string, TokenListItem>([
    [OWN_PAT, item(OWN_PAT)],
    [FOREIGN_PAT, item(FOREIGN_PAT, { userId: 'user-2' })],
    ...([PROJECT_SVC, ORG_SVC, OTHER_PROJECT_SVC] as const).map(
      (id) =>
        [
          id,
          item(id, {
            kind: 'svc',
            userId: null,
            createdByUserId: 'user-2',
            scope: 'read',
            readOnly: true,
            projectMode: null,
            projectId: id === ORG_SVC ? null : id === PROJECT_SVC ? PROJECT : OTHER_PROJECT,
            servicePrincipalId: id === ORG_SVC ? ORG_PRINCIPAL : PROJECT_PRINCIPAL,
            selector: 'SENTINEL-SELECTOR',
            hash: 'SENTINEL-HASH',
            plaintext: 'SENTINEL-PLAINTEXT',
          }),
        ] as const,
    ),
  ]);
  let sequence = 0;
  const ids = { ulid: () => `01JA${String(++sequence + 100).padStart(22, '0')}` };
  let failBatch = false;
  const serviceStore = {
    issueService: vi.fn<ServiceTokenStore['issueService']>(),
    getService: vi.fn(async (_org: unknown, id: string) => {
      const row = metadata.get(id);
      return row?.kind === 'svc'
        ? {
            id,
            servicePrincipalId: row.servicePrincipalId!,
            projectId: row.projectId,
            scope: row.scope,
            readOnly: row.readOnly,
            name: row.name,
            expiresAt: row.expiresAt!,
            revokedAt: row.revokedAt,
          }
        : null;
    }),
    rotateService: vi.fn<NonNullable<ServiceTokenStore['rotateService']>>(
      async (_org, _fence, input, mint) => {
        const pair = await mint();
        if (failBatch) return { status: 'refused', reason: 'conflict' };
        const record = input.idempotency;
        const key = record === undefined ? null : `${record.principalKey}|${record.key}`;
        if (key !== null && records.has(key))
          throw new Error('UNIQUE constraint failed: api_idempotency');
        const old = metadata.get(input.tokenId)!;
        const replacedExpiresAt = new Date(
          Math.min(
            Date.parse(old.expiresAt!),
            Date.parse(input.expiresAt),
            Date.parse(input.now) + input.overlapDays * DAY_MS,
          ),
        ).toISOString();
        if (record !== undefined && key !== null) records.set(key, record);
        metadata.set(old.id, { ...old, expiresAt: replacedExpiresAt });
        metadata.set(input.id, {
          ...old,
          id: input.id,
          name: input.name,
          expiresAt: input.expiresAt,
        });
        audits.push(input);
        return { status: 'rotated', id: input.id, plaintext: pair.plaintext, replacedExpiresAt };
      },
    ),
  };
  const sessions = {
    isReauthFresh: () => options.reauth ?? true,
    authenticate: vi.fn(
      async () =>
        ({
          session: { id: 'session-1', userId: 'user-1', identityId: null, reauthAt: NOW },
          principal: { kind: 'user', id: 'user-1' },
        }) as never,
    ),
  };
  const log = (entry: unknown) => {
    logs.push(JSON.stringify(entry));
  };
  const organizations = {
    get: async () => ({ settings: { tokenDefaultExpiryDays: 30 } }) as never,
  };
  const service = createServiceTokenService({
    lifetime,
    tokens: serviceStore,
    principals: {
      get: async (_org, id) => ({
        id,
        name: 'ci',
        projectId: id === ORG_PRINCIPAL ? null : PROJECT,
        createdByUserId: 'user-2',
        status: 'active',
        revision: 1,
        permissions: ['project:read', 'project:packages:read'],
      }),
    },
    authority: { livePermissions: async () => new Set(permissions) },
    sessions,
    organizations,
    providers: { anchors: async () => [] },
    keyring,
    clock,
    ids,
    log,
  });
  const get = (id: string) => metadata.get(id) ?? null;
  const reader = {
    getOwn: vi.fn<TokenReader['getOwn']>(async (_org, userId, id) =>
      get(id)?.userId === userId ? get(id) : null,
    ),
    getProject: vi.fn<TokenReader['getProject']>(async (_org, projectId, id) =>
      get(id)?.projectId === projectId ? get(id) : null,
    ),
    getOrganization: vi.fn<TokenReader['getOrganization']>(async (_org, id) => get(id)),
    listOwn: vi.fn(),
    listProject: vi.fn(),
    listOrganization: vi.fn(),
  };
  const idempotency = {
    find: vi.fn(
      async (_org: unknown, principal: string, key: string) =>
        records.get(`${principal}|${key}`) ?? null,
    ),
  };
  const app = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: tokenRoutes({
      tokens: { personal: { issue: vi.fn() }, service, revoke: { revoke: vi.fn() } },
      reader,
      idempotency,
      sessions,
      organizations,
      lifetime,
      clock,
      ids,
      clientIp: () => '203.0.113.7',
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
          protectedHolder: true,
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
                  level: 'full',
                  readOnly: false,
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
    reader,
    serviceStore,
    records,
    metadata,
    audits,
    logs,
    failBatch: (value: boolean) => {
      failBatch = value;
    },
  };
}

async function normalized(response: Response) {
  const body = (await response.json()) as { error: { requestId?: string } };
  delete body.error.requestId;
  return {
    status: response.status,
    headers: [...response.headers].filter(([key]) => key !== 'x-request-id'),
    body,
  };
}

const projectToken = `/_pb/projects/alpha/tokens/${PROJECT_SVC}`;
const organizationToken = `/_pb/tokens/${ORG_SVC}`;

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

describe('single-token metadata and rotation HTTP routes', () => {
  it('declares all five new operations with unique ids across token routes', () => {
    expect(TOKEN_DETAIL_API_SPECS.map((spec) => spec.api.operationId).sort()).toEqual([
      'getMyToken',
      'getProjectToken',
      'getToken',
      'rotateProjectToken',
      'rotateToken',
    ]);
    const ids = [...TOKEN_API_SPECS, ...TOKEN_DETAIL_API_SPECS].map((spec) => spec.api.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it.each(['/_pb/projects/{project}/tokens/{token}/rotate', '/_pb/tokens/{token}/rotate'])(
    'generates conflict and validation error responses for %s',
    (path) => {
      const responses = generateOpenApi(TOKEN_DETAIL_API_SPECS, {
        title: 'Package Broker',
        version: '2.0.0',
      }).paths[path]!.post!.responses;
      for (const status of ['409', '422']) {
        expect(responses).toHaveProperty(`${status}.content.application/json.schema`, {
          $ref: '#/components/schemas/ErrorEnvelope',
        });
      }
    },
  );
  it('lets a project owner inspect another issuer’s token and projects only public metadata', async () => {
    const f = await fixture();
    const response = await f.request('GET', projectToken);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      item(PROJECT_SVC, {
        kind: 'svc',
        userId: null,
        createdByUserId: 'user-2',
        scope: 'read',
        readOnly: true,
        projectMode: null,
        projectId: PROJECT,
        servicePrincipalId: PROJECT_PRINCIPAL,
      }),
    );
    expect(f.reader.getProject).toHaveBeenCalledWith(
      orgContext('org-1'),
      PROJECT,
      PROJECT_SVC,
      NOW,
    );
  });
  it('gets own metadata with the authenticated user boundary', async () => {
    const f = await fixture();
    expect((await f.request('GET', `/_pb/me/tokens/${OWN_PAT}`)).status).toBe(200);
    expect(f.reader.getOwn).toHaveBeenCalledWith(orgContext('org-1'), 'user-1', OWN_PAT, NOW);
  });
  it('gets organization metadata at the organization boundary', async () => {
    const f = await fixture();
    expect((await f.request('GET', organizationToken)).status).toBe(200);
    expect(f.reader.getOrganization).toHaveBeenCalledWith(orgContext('org-1'), ORG_SVC, NOW);
  });
  it('hides a foreign project token exactly like an absent id', async () => {
    const f = await fixture();
    expect(
      await normalized(await f.request('GET', `/_pb/projects/alpha/tokens/${OTHER_PROJECT_SVC}`)),
    ).toEqual(await normalized(await f.request('GET', `/_pb/projects/alpha/tokens/${ABSENT}`)));
    expect((await f.request('GET', `/_pb/projects/alpha/tokens/${ABSENT}`)).status).toBe(404);
  });
  it('hides another user’s personal token like an absent id', async () => {
    const f = await fixture();
    expect(await normalized(await f.request('GET', `/_pb/me/tokens/${FOREIGN_PAT}`))).toEqual(
      await normalized(await f.request('GET', `/_pb/me/tokens/${ABSENT}`)),
    );
  });
  it('returns the uniform 404 for absent organization metadata', async () => {
    const f = await fixture();
    await expectError(await f.request('GET', `/_pb/tokens/${ABSENT}`), 404, 'not_found');
  });
  it.each([projectToken, organizationToken])(
    'rotates %s once and replays only the replacement id',
    async (path) => {
      const f = await fixture();
      const first = await f.request('POST', `${path}/rotate`, {
        body: { overlapDays: 7 },
        key: 'rotate-once',
      });
      expect(first.status).toBe(201);
      expect(first.headers.get('cache-control')).toBe('no-store');
      const issued = (await first.json()) as {
        id: string;
        token: string;
        replacedTokenId: string;
        replacedExpiresAt: string;
      };
      expect(issued).toEqual({
        id: expect.any(String),
        token: expect.stringMatching(/^pb_svc_/),
        replacedTokenId: path.split('/').at(-1),
        replacedExpiresAt: inDays(7),
      });
      const replay = await f.request('POST', `${path}/rotate`, {
        body: { overlapDays: 7 },
        key: 'rotate-once',
      });
      expect(replay.status).toBe(409);
      expect(replay.headers.get('idempotent-replayed')).toBe('true');
      expect(await replay.json()).toEqual({
        id: issued.id,
        error: { code: 'already_issued', message: 'Already issued', requestId: expect.any(String) },
      });
      expect(f.serviceStore.rotateService).toHaveBeenCalledTimes(1);
      expect(await (await f.request('GET', path)).json()).toMatchObject({ expiresAt: inDays(7) });
      expect(JSON.stringify([f.logs, f.audits, [...f.records.values()]])).not.toContain(
        issued.token,
      );
    },
  );
  it('leaves no replay record or rotation after a refused batch and allows retry', async () => {
    const f = await fixture();
    f.failBatch(true);
    await expectError(
      await f.request('POST', `${projectToken}/rotate`, { body: { overlapDays: 7 }, key: 'retry' }),
      409,
      'conflict',
    );
    expect(f.serviceStore.rotateService.mock.calls[0]?.[2].idempotency).toBeDefined();
    expect(f.records.size).toBe(0);
    expect(f.metadata.size).toBe(5);
    expect(f.metadata.get(PROJECT_SVC)?.expiresAt).toBe(inDays(30));
    expect(f.audits).toHaveLength(0);
    f.failBatch(false);
    expect(
      (
        await f.request('POST', `${projectToken}/rotate`, {
          body: { overlapDays: 7 },
          key: 'retry',
        })
      ).status,
    ).toBe(201);
    expect(f.records.size).toBe(1);
    expect(f.audits).toHaveLength(1);
  });
  it('declares only 0, 1 and 7 as accepted overlap values in the strict schema', () => {
    for (const spec of TOKEN_DETAIL_API_SPECS) {
      if (spec.method !== 'POST') continue;
      for (const overlapDays of [0, 1, 7])
        expect(spec.api.body.safeParse({ overlapDays }).success).toBe(true);
      expect(spec.api.body.safeParse({ overlapDays: 2 }).success).toBe(false);
    }
  });
  it('rejects overlap 2 with 422 before any token store call', async () => {
    const f = await fixture();
    await expectError(
      await f.request('POST', `${projectToken}/rotate`, { body: { overlapDays: 2 } }),
      422,
      'invalid_overlap',
    );
    expect(f.serviceStore.getService).not.toHaveBeenCalled();
    expect(f.serviceStore.rotateService).not.toHaveBeenCalled();
  });
  it.each([
    ['GET', `/_pb/me/tokens/${OWN_PAT}`],
    ['GET', projectToken],
    ['GET', organizationToken],
    ['POST', `${projectToken}/rotate`],
    ['POST', `${organizationToken}/rotate`],
  ])('denies token credentials on %s %s', async (method, path) => {
    const f = await fixture();
    await expectError(
      await f.request(method, path, {
        auth: 'token',
        ...(method === 'POST' ? { body: { overlapDays: 7 } } : {}),
      }),
      403,
      'forbidden',
    );
    expect(f.serviceStore.getService).not.toHaveBeenCalled();
    expect(f.serviceStore.rotateService).not.toHaveBeenCalled();
    expect(f.reader.getOwn).not.toHaveBeenCalled();
    expect(f.reader.getProject).not.toHaveBeenCalled();
    expect(f.reader.getOrganization).not.toHaveBeenCalled();
  });
  it.each([
    [{ overlapDays: 7, expiresAt: inDays(1), lifetimeDays: 1 }, 'invalid_expiry'],
    [{ overlapDays: 7, lifetimeDays: 366 }, 'invalid_expiry'],
    [{ overlapDays: 7, name: '' }, 'invalid_name'],
  ])('returns 422 for invalid replacement fields %j', async (body, code) => {
    const f = await fixture();
    await expectError(await f.request('POST', `${projectToken}/rotate`, { body }), 422, code);
    expect(f.serviceStore.getService).not.toHaveBeenCalled();
    expect(f.serviceStore.rotateService).not.toHaveBeenCalled();
  });
  describe.each([projectToken, organizationToken])('rotation body validation for %s', (path) => {
    it.each([
      { overlapDays: 7, expiresAt: null },
      { overlapDays: 7, lifetimeDays: 1.5 },
    ])('returns 422 invalid_expiry for schema-rejected expiry fields %j', async (body) => {
      const f = await fixture();
      await expectError(await f.request('POST', `${path}/rotate`, { body }), 422, 'invalid_expiry');
      expect(f.serviceStore.getService).not.toHaveBeenCalled();
      expect(f.serviceStore.rotateService).not.toHaveBeenCalled();
    });
    it.each([null, [], { overlapDays: 7, name: 42 }, { overlapDays: 7, scope: 'full' }])(
      'keeps unrelated malformed bodies at 400 invalid_request for %j',
      async (body) => {
        const f = await fixture();
        await expectError(
          await f.request('POST', `${path}/rotate`, { body }),
          400,
          'invalid_request',
        );
        expect(f.serviceStore.getService).not.toHaveBeenCalled();
        expect(f.serviceStore.rotateService).not.toHaveBeenCalled();
      },
    );
  });
  it('accepts lifetimeDays and a replacement name', async () => {
    const f = await fixture();
    expect(
      (
        await f.request('POST', `${projectToken}/rotate`, {
          body: { overlapDays: 1, lifetimeDays: 2, name: 'replacement' },
        })
      ).status,
    ).toBe(201);
    expect(f.audits[0]).toMatchObject({
      expiresAt: inDays(2),
      name: 'replacement',
      projectId: PROJECT,
    });
  });
  it('rejects unknown rotation fields', async () => {
    const f = await fixture();
    await expectError(
      await f.request('POST', `${projectToken}/rotate`, {
        body: { overlapDays: 7, scope: 'full' },
      }),
      400,
      'invalid_request',
    );
    expect(f.serviceStore.getService).not.toHaveBeenCalled();
  });
  it('does not replay a key used on another token', async () => {
    const f = await fixture();
    const init = { body: { overlapDays: 7 }, key: 'bound-token' };
    expect((await f.request('POST', `${projectToken}/rotate`, init)).status).toBe(201);
    await expectError(
      await f.request('POST', `${organizationToken}/rotate`, init),
      409,
      'idempotency_mismatch',
    );
    expect(f.serviceStore.rotateService).toHaveBeenCalledTimes(1);
  });
  it('requires fresh reauthentication', async () => {
    const f = await fixture({ reauth: false });
    await expectError(
      await f.request('POST', `${projectToken}/rotate`, { body: { overlapDays: 7 } }),
      403,
      'reauth_required',
    );
    expect(f.serviceStore.getService).not.toHaveBeenCalled();
  });
  it('denies rotation without revoke permission', async () => {
    const f = await fixture({
      permissions: ['project:read', 'project:packages:read', 'project:tokens:create'],
    });
    await expectError(
      await f.request('POST', `${projectToken}/rotate`, { body: { overlapDays: 7 } }),
      403,
      'forbidden',
    );
    expect(f.serviceStore.rotateService).not.toHaveBeenCalled();
  });
  it('hides a foreign project rotation like an absent id', async () => {
    const f = await fixture();
    const init = { body: { overlapDays: 7 } };
    expect(
      await normalized(
        await f.request('POST', `/_pb/projects/alpha/tokens/${OTHER_PROJECT_SVC}/rotate`, init),
      ),
    ).toEqual(
      await normalized(
        await f.request('POST', `/_pb/projects/alpha/tokens/${ABSENT}/rotate`, init),
      ),
    );
    expect(f.serviceStore.rotateService).not.toHaveBeenCalled();
  });
});
