import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../auth/cookies.js';
import { sha256Hex } from '../../auth/primitives.js';
import {
  createAuthorizationEngine,
  patValidationGate,
  type EngineTokenAccess,
} from '../../authz/engine.js';
import { orgContext } from '../../db/port.js';
import type { SourceListQuery, SourceRecord } from '../../db/source.js';
import { fixedClock } from '../../ids.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { formatToken } from '../../secrets/token-format.js';
import { hashToken } from '../../secrets/token-hash.js';
import { createSourceService } from '../../sources/source-service.js';
import { defineApi } from '../route.js';
import { generateOpenApi } from '../openapi.js';
import { ACCEPT_REMOVAL_API_SPEC, SOURCE_API_SPECS } from './sources-schemas.js';
import { sourceRoutes } from './sources.js';

const ORIGIN = 'https://broker.test';
const PROJECT = '01JA0000000000000000000001';
const OTHER_PROJECT = '01JA0000000000000000000002';
const SOURCE = '01JA0000000000000000000003';
const SECOND = '01JA0000000000000000000004';
const SESSION = 'A'.repeat(43);
const CSRF = 'B'.repeat(43);
const SENTINEL = 'credential-sentinel-987654321';
const credential = { kind: 'bearer', material: JSON.stringify({ token: SENTINEL }) };
const create = {
  name: 'private',
  ecosystem: 'composer',
  type: 'composer_repository',
  url: 'https://packages.example.com',
};
const clock = fixedClock('2026-10-21T00:00:00.000Z');
const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
const bearer = formatToken('pat', 'abcdefghijkl', new Uint8Array(32).fill(9));
const fields = [
  'id',
  'projectId',
  'name',
  'ecosystem',
  'type',
  'url',
  'status',
  'removalPolicy',
  'pollIntervalSeconds',
  'lastSuccessAt',
  'lastError',
  'lastPolledAt',
  'nextPollAt',
  'hasCredential',
  'config',
  'configComplete',
  'userAgent',
  'retentionDaysOverride',
  'defaultVisibleToNewProjects',
].sort();

async function fixture(
  options: {
    organizationPermissions?: readonly string[];
    admin?: boolean;
    tokenInherited?: boolean;
    tokenAdmin?: boolean;
    tokenKind?: 'pat' | 'svc';
    tokenProjectMode?: 'all' | 'selected' | null;
    tokenProjectIds?: readonly string[];
    acceptRemoval?: boolean;
    refusal?: SourceRecord['removalRefusal'];
    armed?: boolean;
    projectPermissions?: readonly string[];
    projectState?: 'absent' | 'archived' | 'foreign' | 'invisible';
    archivedAfterAuthorization?: boolean;
    sourceProject?: string | null;
    sourceAbsent?: boolean;
    sourceAttached?: boolean;
    reauth?: boolean;
    sessionMismatch?: boolean;
    rows?: readonly SourceRecord[];
    vcsProviders?: readonly ('github' | 'git' | 'ssh')[];
    refuseVcsProvider?: (provider: 'github' | 'git' | 'ssh') => boolean;
  } = {},
) {
  const tokenBearer =
    options.tokenKind === 'svc'
      ? formatToken('svc', 'abcdefghijkl', new Uint8Array(32).fill(9))
      : bearer;
  const logs: string[] = [];
  const log = (entry: unknown) => {
    logs.push(JSON.stringify(entry));
  };
  let sequence = 0;
  const ids = { ulid: () => `01JB${String(++sequence).padStart(22, '0')}` };
  const projectRecord =
    options.projectState === 'absent'
      ? null
      : {
          id: PROJECT,
          orgId: options.projectState === 'foreign' ? 'org-2' : 'org-1',
          status:
            options.projectState === 'archived' || options.archivedAfterAuthorization
              ? 'archived'
              : 'active',
          revision: 7,
        };
  const scopedProject = projectRecord?.orgId === 'org-1' ? projectRecord : null;
  const authorizedProject =
    scopedProject !== null &&
    (scopedProject.status === 'active' || options.archivedAfterAuthorization)
      ? { id: scopedProject.id }
      : null;
  const row = {
    ...create,
    id: SOURCE,
    projectId: options.sourceProject ?? null,
    configJson: '{}',
    credentialId: 'hidden-credential',
    lastError: SENTINEL,
    status: 'paused',
    removalPolicy: 'flag',
    pollIntervalSeconds: 300,
    lastSuccessAt: null,
    lastPolledAt: null,
    nextPollAt: null,
    removalRefusal: options.refusal === undefined ? null : options.refusal,
    removalAccepted: options.armed ?? false,
  } as SourceRecord;
  const sources = {
    syncNow: vi.fn().mockResolvedValue('requested'),
    acceptRemoval: vi.fn().mockResolvedValue('accepted'),
    countAttachedProjects: vi.fn().mockResolvedValue(new Map([[SOURCE, 2]])),
    get: vi.fn(async () => (options.sourceAbsent ? null : row)),
    getVisible: vi.fn(async () =>
      !options.sourceAbsent &&
      scopedProject?.status === 'active' &&
      (row.projectId === PROJECT || (row.projectId === null && options.sourceAttached))
        ? row
        : null,
    ),
    create: vi.fn(async () => 'created' as const),
    update: vi.fn(async () => 'updated' as const),
    delete: vi.fn(async () => 'deleted' as const),
    resume: vi.fn(async () => 'activation_requires_registered_names' as const),
    pause: vi.fn(async () => 'paused' as const),
    list: vi.fn(async (_org: unknown, input: SourceListQuery) =>
      [...(options.rows ?? [row])]
        .filter(
          (r) =>
            input.projectId !== null ||
            input.ownership === 'all' ||
            (input.ownership === 'project' ? r.projectId !== null : r.projectId === null),
        )
        .filter((r) => input.after === null || r.id > input.after)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, input.limit + 1),
    ),
  };
  const credentials = {
    prepare: vi.fn(async () => ({ id: 'sealed-id', statement: { sql: 'sealed', params: [] } })),
  };
  const service = createSourceService({
    sources,
    credentials,
    organizations: {
      get: vi.fn().mockResolvedValue({ settings: { retentionRemovedUpstreamDays: 30 } }),
    },
    registeredNames: {
      get: async () => null,
      claimProxy: async () => null,
      list: vi.fn(),
      owner: vi.fn(),
      add: vi.fn(),
      remove: vi.fn(),
      enable: vi.fn(),
    },
    credentialRepository: { get: vi.fn().mockResolvedValue(null) },
    catalogue: { previewWinners: vi.fn() },
    policy: { runtime: 'node', allowPrivateHosts: [], selfOrigins: [ORIGIN] },
    providerAnchors: [],
    ids,
    log,
  });
  const pause = vi.spyOn(service, 'pause');
  const createSource = vi.spyOn(service, 'create');
  const update = vi.spyOn(service, 'update');
  const list = vi.spyOn(service, 'list');
  const getVisible = vi.spyOn(service, 'getVisible');
  const resume = vi.spyOn(service, 'resume');
  const syncNow = vi.spyOn(service, 'syncNow');
  const sessions = {
    authenticate: vi.fn().mockResolvedValue({
      session: { id: options.sessionMismatch ? 'other-session' : 'session-1', userId: 'user-1' },
    }),
    isReauthFresh: vi.fn(() => options.reauth ?? true),
  };
  const projects = { get: vi.fn().mockResolvedValue(scopedProject) };
  const clientIp = vi.fn(() => '203.0.113.7');
  const orgPermissions = options.organizationPermissions ?? [
    'org:sources:read',
    'org:sources:write',
  ];
  const projectPermissions = options.projectPermissions ?? [
    'project:read',
    'project:sources:read',
    'project:sources:write',
  ];
  const { acceptRemoval, ...baseService } = service;
  const app = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: sourceRoutes({
      service: { ...baseService, ...(options.acceptRemoval === false ? {} : { acceptRemoval }) },
      sources,
      projects,
      sessions,
      projectSources: { list: vi.fn(async () => [{ sourceId: SECOND, precedence: 2 }]) },
      ids,
      clock,
      clientIp,
      ...(options.vcsProviders === undefined
        ? {}
        : { vcsProviders: () => options.vcsProviders ?? [] }),
      ...(options.refuseVcsProvider === undefined
        ? {}
        : { refuseVcsProvider: options.refuseVcsProvider }),
    }),
    ports: { organizations: { get: async () => null }, ids, clock },
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    log,
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async (_org, input) => ({
          session: { id: 'session-1', csrfHash: await sha256Hex(CSRF) },
          user: { id: 'user-1' },
          identity: null,
          protectedHolder: options.admin ?? false,
          project: input.boundary === 'project' ? authorizedProject : null,
          organizationPermissions: orgPermissions,
          projectPermissions: options.projectState === 'invisible' ? [] : projectPermissions,
        }),
        lookupToken: async (_org, input) =>
          Object.defineProperty(
            {
              token: {
                id: 'token-1',
                kind: options.tokenKind ?? 'pat',
                expired: false,
                revoked: false,
                lastUsedAt: null,
                userId: options.tokenKind === 'svc' ? null : 'user-1',
                servicePrincipalId: options.tokenKind === 'svc' ? 'service-1' : null,
                bindingOk: true,
                projectMode:
                  options.tokenProjectMode === undefined
                    ? options.tokenKind === 'svc'
                      ? 'selected'
                      : 'all'
                    : options.tokenProjectMode,
                boundProjectIds: options.tokenProjectIds ?? [],
                scope: { level: 'read', readOnly: true },
              },
              principalStatus: 'active',
              projectReadInherited: options.tokenInherited ?? false,
              protectedHolder: options.tokenAdmin ?? false,
              projectVisible: authorizedProject !== null && options.projectState !== 'invisible',
              validation: { kind: 'local', identityId: null, fresh: true, evidenceAt: null },
              project: input.boundary === 'project' ? authorizedProject : null,
              organizationPermissions: ['org:sources:read'],
              projectPermissions:
                options.projectState === 'invisible' ? [] : ['project:sources:read'],
            },
            'verifier',
            { value: { secretHash: await hashToken(keyring, 1, tokenBearer), pepperVersion: 1 } },
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
        log,
      },
      patValidation: patValidationGate,
      publicOrigin: ORIGIN,
      providerAnchors: async () => [],
    }),
  });
  const request = (method: string, path: string, body?: unknown, token = false) => {
    const headers = new Headers({ origin: ORIGIN, 'content-type': 'application/json' });
    if (token) headers.set('authorization', `Bearer ${tokenBearer}`);
    else {
      headers.set('cookie', `${SESSION_COOKIE}=${SESSION}`);
      headers.set('x-csrf-token', CSRF);
    }
    return app.fetch(
      new Request(ORIGIN + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  };
  return {
    request,
    sources,
    credentials,
    logs,
    pause,
    createSource,
    update,
    list,
    getVisible,
    resume,
    syncNow,
    projects,
    sessions,
    clientIp,
  };
}

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

it('declares all fourteen routes as exportable API specs', () => {
  expect(SOURCE_API_SPECS).toHaveLength(14);
  for (const spec of SOURCE_API_SPECS) expect(() => defineApi(spec)).not.toThrow();
});

for (const base of ['/_pb/sources', '/_pb/projects/demo/sources']) {
  const project = base.includes('/projects/');
  const setup = (extra: Parameters<typeof fixture>[0] = {}) =>
    fixture({ sourceProject: project ? PROJECT : null, ...extra });
  describe(base, () => {
    it('lists the VCS providers the runtime reports', async () => {
      const f = await setup({ vcsProviders: ['github', 'git', 'ssh'] });
      const response = await f.request('GET', base);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ vcsProviders: ['github', 'git', 'ssh'] });
    });
    it('refuses to create or reconfigure a source for a provider the runtime has not registered', async () => {
      const f = await setup({ refuseVcsProvider: (provider) => provider === 'git' });
      const git = {
        provider: 'git',
        repository: 'https://git.example.com/acme/lib.git',
        refs: { tags: true, branches: [] },
      };
      const refused = {
        error: {
          code: 'invalid_request',
          details: [{ path: '/body/config/provider', code: 'invalid' }],
        },
      };
      const created = await f.request('POST', base, {
        name: 'git',
        ecosystem: 'composer',
        type: 'vcs',
        url: null,
        config: git,
      });
      expect(created.status).toBe(400);
      expect(await created.json()).toMatchObject(refused);
      expect(f.sources.create).not.toHaveBeenCalled();
      const updated = await f.request('PATCH', `${base}/${SOURCE}`, { config: git });
      expect(updated.status).toBe(400);
      expect(await updated.json()).toMatchObject(refused);
      expect(f.sources.update).not.toHaveBeenCalled();
      const github = await f.request('POST', base, {
        name: 'github',
        ecosystem: 'composer',
        type: 'vcs',
        url: null,
        config: { provider: 'github', repository: 'acme/lib', installationId: 1 },
      });
      expect(github.status).not.toBe(400);
    });
    it('lists no VCS providers when the runtime reports none', async () => {
      const f = await setup();
      const response = await f.request('GET', base);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { vcsProviders: unknown }).vcsProviders).toEqual([]);
    });
    it('requests a sync with 202 using the source write fence and audit context', async () => {
      const f = await setup();
      const response = await f.request('POST', `${base}/${SOURCE}/sync`);
      expect(response.status).toBe(202);
      expect(await response.json()).toBe(null);
      expect(f.sources.syncNow).toHaveBeenCalledOnce();
      expect(f.sources.syncNow.mock.calls[0]).toMatchObject([
        { orgId: 'org-1' },
        { userId: 'user-1', sessionId: 'session-1' },
        {
          id: SOURCE,
          audit: { action: 'source.sync_requested', projectId: project ? PROJECT : null },
        },
      ]);
    });
    it('returns the stable paused-source problem', async () => {
      const f = await setup();
      f.sources.syncNow.mockResolvedValue('source_paused');
      const response = await f.request('POST', `${base}/${SOURCE}/sync`);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: 'source_paused', message: 'Source is paused' },
      });
    });
    it('applies the same token denial and missing-source semantics to sync and pause', async () => {
      const f = await setup();
      expect(
        await normalized(await f.request('POST', `${base}/${SOURCE}/sync`, undefined, true)),
      ).toEqual(
        await normalized(await f.request('POST', `${base}/${SOURCE}/pause`, undefined, true)),
      );
      expect(f.sources.syncNow).not.toHaveBeenCalled();
      const missing = await setup({ sourceAbsent: true });
      expect((await missing.request('POST', `${base}/${SOURCE}/sync`)).status).toBe(404);
      expect(missing.sources.syncNow).not.toHaveBeenCalled();
    });
    it.each([
      ['material', credential, 204],
      ['wrong-typed field', { ...credential, material: { token: SENTINEL } }, 400],
      ['unknown property', { ...credential, [SENTINEL]: SENTINEL }, 400],
    ] as const)('never echoes a sentinel in %s', async (_name, body, status) => {
      const f = await setup();
      const response = await f.request('PUT', `${base}/${SOURCE}/credential`, body);
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(SENTINEL);
      expect(JSON.stringify([...response.headers])).not.toContain(SENTINEL);
      expect(f.logs.join('\n')).not.toContain(SENTINEL);
      if (status === 400) expect(f.credentials.prepare).not.toHaveBeenCalled();
    });
    it('writes a credential with 204, no body and no-store', async () => {
      const f = await setup();
      const response = await f.request('PUT', `${base}/${SOURCE}/credential`, credential);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(f.credentials.prepare).toHaveBeenCalledOnce();
      expect(f.update.mock.calls[0]?.[4]).toEqual({
        credential: { kind: 'bearer', plaintext: credential.material },
      });
    });
    it('denies a read-scope token before writing', async () => {
      const f = await setup();
      expect(
        (await f.request('PUT', `${base}/${SOURCE}/credential`, credential, true)).status,
      ).toBe(403);
      expect(f.credentials.prepare).not.toHaveBeenCalled();
    });
    it('requires fresh reauthentication before writing', async () => {
      const f = await setup({ reauth: false });
      const response = await f.request('PUT', `${base}/${SOURCE}/credential`, credential);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'reauth_required' } });
      expect(f.credentials.prepare).not.toHaveBeenCalled();
    });
    it('rejects a reauthenticated session belonging to another session', async () => {
      const f = await setup({ sessionMismatch: true });
      expect((await f.request('PUT', `${base}/${SOURCE}/credential`, credential)).status).toBe(403);
      expect(f.credentials.prepare).not.toHaveBeenCalled();
    });
    it('rejects a malformed credential without echoing it', async () => {
      const f = await setup();
      const response = await f.request('PUT', `${base}/${SOURCE}/credential`, {
        kind: 'bearer',
        material: SENTINEL,
      });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(SENTINEL);
      expect(f.credentials.prepare).not.toHaveBeenCalled();
    });
    it('refuses a private source URL at its declared pointer', async () => {
      const f = await setup();
      const url = 'https://127.0.0.1/private';
      const response = await f.request('POST', base, { ...create, url });
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({
        error: { code: 'invalid_request', details: [{ path: '/body/url', code: 'invalid' }] },
      });
      expect(text).not.toContain(url);
      expect(f.sources.create).not.toHaveBeenCalled();
    });
    it('refuses a private distribution host without echoing it', async () => {
      const f = await setup();
      const response = await f.request('POST', base, {
        ...create,
        config: { distHosts: ['127.0.0.1'] },
      });
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).not.toContain('127.0.0.1');
      expect(JSON.parse(text)).toMatchObject({
        error: { details: [{ path: '/body/config/distHosts' }] },
      });
      expect(f.sources.create).not.toHaveBeenCalled();
    });
    it('returns 409 without resuming a non-proxy', async () => {
      const f = await setup();
      const response = await f.request('POST', `${base}/${SOURCE}/resume`);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'conflict' } });
      expect(f.sources.update).not.toHaveBeenCalled();
    });
    it('creates with server ownership and maps config to JSON', async () => {
      const f = await setup();
      const response = await f.request('POST', base, {
        ...create,
        config: {},
        userAgent: 'broker',
        pollIntervalSeconds: 60,
        removalPolicy: 'exclude',
        retentionDaysOverride: 40,
        defaultVisibleToNewProjects: true,
      });
      expect(response.status).toBe(201);
      expect(f.createSource.mock.calls[0]?.[3]).toEqual({
        ...create,
        projectId: project ? PROJECT : null,
        configJson: '{}',
        userAgent: 'broker',
        pollIntervalSeconds: 60,
        removalPolicy: 'exclude',
        retentionDaysOverride: 40,
        defaultVisibleToNewProjects: true,
      });
    });
    it('rejects caller-supplied owner and provider fields', async () => {
      const f = await setup();
      expect(
        (
          await f.request('POST', base, {
            ...create,
            projectId: OTHER_PROJECT,
            providerAnchors: [],
            id: SOURCE,
          })
        ).status,
      ).toBe(400);
      expect(f.createSource).not.toHaveBeenCalled();
    });
    it('updates without If-Match and maps config', async () => {
      const f = await setup();
      expect(
        (await f.request('PATCH', `${base}/${SOURCE}`, { config: {}, userAgent: null })).status,
      ).toBe(204);
      expect(f.update.mock.calls[0]?.[4]).toEqual({ configJson: '{}', userAgent: null });
    });
    it('rejects an empty update', async () => {
      const f = await setup();
      expect((await f.request('PATCH', `${base}/${SOURCE}`, {})).status).toBe(400);
      expect(f.sources.update).not.toHaveBeenCalled();
    });
    it('rejects a non-ULID source id', async () => {
      const f = await setup();
      expect((await f.request('PATCH', `${base}/invalid`, { userAgent: null })).status).toBe(400);
      expect(f.update).not.toHaveBeenCalled();
    });
    it('pauses with authenticated context, a fresh opId and audit call', async () => {
      const f = await setup();
      expect((await f.request('POST', `${base}/${SOURCE}/pause`)).status).toBe(204);
      expect((await f.request('POST', `${base}/${SOURCE}/pause`)).status).toBe(204);
      const [first, second] = f.pause.mock.calls;
      expect(first?.[2]).toEqual({ userId: 'user-1', sessionId: 'session-1', expected: {} });
      expect(first?.[4].audit).toMatchObject({
        sourceIp: '203.0.113.7',
        tokenSelector: null,
        requestId: expect.any(String),
      });
      expect(first?.[4].audit.opId).not.toBe(second?.[4].audit.opId);
    });
    it('returns a safe, explicit source DTO and project ordering ETag', async () => {
      const raw = {
        ...create,
        id: SOURCE,
        projectId: project ? PROJECT : null,
        url: `https://user:${SENTINEL}@packages.example.com/?token=${SENTINEL}`,
        credentialId: SENTINEL,
        configJson: SENTINEL,
        userAgent: 'Broker/2.0',
        retentionDaysOverride: 730,
        defaultVisibleToNewProjects: true,
        lastError: SENTINEL,
        status: 'active',
        removalPolicy: 'flag',
        pollIntervalSeconds: 60,
        lastSuccessAt: null,
        lastPolledAt: null,
        nextPollAt: null,
      } as SourceRecord;
      const f = await setup({ rows: [raw] });
      const response = await f.request('GET', base);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(SENTINEL);
      const body = JSON.parse(text) as { items: Record<string, unknown>[]; next: string | null };
      expect(Object.keys(body.items[0]!).sort()).toEqual(
        project
          ? [...fields, 'attached'].sort()
          : [...fields, 'attachedProjectCount', 'projectName'].sort(),
      );
      if (!project) expect(body.items[0]?.attachedProjectCount).toBe(2);
      expect(body.items[0]?.hasCredential).toBe(true);
      expect(body.items[0]?.url).toBe('https://packages.example.com/');
      expect(body.next).toBe(null);
      expect(response.headers.get('etag')).toBe(project ? '"r7"' : null);
    });
    it('allows a read token to list sources', async () => {
      const f = await setup();
      expect((await f.request('GET', base, undefined, true)).status).toBe(200);
    });
    it('uses 50 as the default list limit', async () => {
      const f = await setup();
      expect((await f.request('GET', base)).status).toBe(200);
      expect(f.sources.list.mock.calls[0]?.[1]).toMatchObject({ limit: 50 });
    });
    it.each(['0', '101', 'invalid'])('rejects list limit %s', async (limit) => {
      const f = await setup();
      expect((await f.request('GET', `${base}?limit=${limit}`)).status).toBe(400);
      expect(f.list).not.toHaveBeenCalled();
    });
  });
}

it('denies organization create to a project actor and allows their project create', async () => {
  const f = await fixture({ organizationPermissions: [] });
  expect((await f.request('POST', '/_pb/sources', create)).status).toBe(403);
  expect((await f.request('POST', '/_pb/projects/demo/sources', create)).status).toBe(201);
});

it('answers the same 404 for foreign and absent project sources', async () => {
  const foreign = await fixture({ sourceProject: OTHER_PROJECT });
  const absent = await fixture({ sourceAbsent: true });
  const path = `/_pb/projects/demo/sources/${SOURCE}`;
  const answer = await normalized(await foreign.request('PATCH', path, { userAgent: null }));
  expect(answer.status).toBe(404);
  expect(answer).toEqual(
    await normalized(await absent.request('PATCH', path, { userAgent: null })),
  );
});

it.each(['absent', 'archived', 'foreign', 'invisible'] as const)(
  'normalizes a source 404 against an %s project',
  async (projectState) => {
    const absent = await fixture({ sourceAbsent: true });
    const hidden = await fixture({ projectState });
    const path = `/_pb/projects/demo/sources/${SOURCE}`;
    expect(await normalized(await hidden.request('PATCH', path, { userAgent: null }))).toEqual(
      await normalized(await absent.request('PATCH', path, { userAgent: null })),
    );
  },
);

it.each([
  [false, false, false],
  [false, true, false],
  [false, false, true],
  [true, false, false],
  [true, true, false],
  [true, false, true],
])(
  'passes count visibility for token %s, inherited read %s, admin %s',
  async (token, inherited, admin) => {
    const f = await fixture({
      admin,
      organizationPermissions: ['org:sources:read', ...(inherited ? ['project:read'] : [])],
      tokenInherited: inherited,
      tokenAdmin: admin,
    });
    const response = await f.request('GET', '/_pb/sources', undefined, token);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ attachedProjectCount: 2 }] });
    expect(f.sources.countAttachedProjects).toHaveBeenCalledExactlyOnceWith(orgContext('org-1'), {
      sourceIds: [SOURCE],
      userId: 'user-1',
      allProjects: admin || inherited,
      includeArchived: admin,
      providerAnchors: [],
    });
  },
);

it.each([
  ['selected', [PROJECT]],
  ['selected', []],
  [null, []],
] as const)('passes PAT project caps to attachment counts: %s %j', async (mode, ids) => {
  const f = await fixture({
    tokenProjectMode: mode,
    tokenProjectIds: ids,
    tokenInherited: true,
    tokenAdmin: true,
  });
  const response = await f.request('GET', '/_pb/sources', undefined, true);
  expect(response.status).toBe(200);
  expect(f.sources.countAttachedProjects).toHaveBeenCalledExactlyOnceWith(orgContext('org-1'), {
    sourceIds: [SOURCE],
    userId: 'user-1',
    allProjects: true,
    includeArchived: false,
    providerAnchors: [],
    restrictTo: ids,
  });
});

it('uses service token authority to count only projects within its scope', async () => {
  const f = await fixture({ tokenKind: 'svc' });
  f.sources.countAttachedProjects.mockResolvedValue(new Map([[SOURCE, 1]]));
  const response = await f.request('GET', '/_pb/sources', undefined, true);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ items: [{ attachedProjectCount: 1 }] });
  expect(f.sources.countAttachedProjects).toHaveBeenCalledExactlyOnceWith(orgContext('org-1'), {
    sourceIds: [SOURCE],
    userId: 'service-1',
    servicePrincipalId: 'service-1',
    allProjects: false,
    includeArchived: false,
    providerAnchors: [],
  });
});

it('pages in id order using after and next IDs', async () => {
  const rows = [SECOND, SOURCE].map(
    (id) =>
      ({
        ...create,
        id,
        projectId: null,
        configJson: '{}',
        credentialId: null,
        status: 'paused',
        removalPolicy: 'flag',
        pollIntervalSeconds: 60,
        lastSuccessAt: null,
        lastPolledAt: null,
        nextPollAt: null,
      }) as SourceRecord,
  );
  const f = await fixture({ rows });
  const first = await f.request('GET', '/_pb/sources?limit=1');
  expect(await first.json()).toMatchObject({
    items: [{ id: SOURCE, hasCredential: false, attachedProjectCount: 2 }],
    next: SOURCE,
  });
  const second = await f.request('GET', `/_pb/sources?limit=1&after=${SOURCE}`);
  expect(await second.json()).toMatchObject({
    items: [{ id: SECOND, attachedProjectCount: 0 }],
    next: null,
  });
  expect(f.sources.list.mock.calls[1]?.[1]).toEqual({ projectId: null, after: SOURCE, limit: 1 });
});

const mutations = [
  ['PATCH', '', { userAgent: null }],
  ['POST', '/pause', undefined],
  ['POST', '/sync', undefined],
  ['POST', '/resume', undefined],
  ['PUT', '/credential', credential],
] as const;

describe.each(mutations)('organization source %s %s', (method, suffix, body) => {
  const path = `/_pb/sources/${SOURCE}${suffix}`;

  it.each([
    ['absent source', { sourceAbsent: true }],
    ['project-owned source', { sourceProject: PROJECT }],
  ] as const)('hides %s with the kernel absent-route 404', async (_state, target) => {
    const f = await fixture(target);
    const baseline = await normalized(await f.request('GET', '/_pb/absent-route'));
    expect(baseline.status).toBe(404);
    expect(await normalized(await f.request(method, path, body))).toEqual(baseline);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.sources.update).not.toHaveBeenCalled();
    expect(f.sources.pause).not.toHaveBeenCalled();
    expect(f.sources.resume).not.toHaveBeenCalled();
    expect(f.credentials.prepare).not.toHaveBeenCalled();
  });

  it.each([
    ['existing', { sourceProject: null }],
    ['absent', { sourceAbsent: true }],
  ] as const)(
    'denies an %s target identically before lookup without write permission',
    async (_state, target) => {
      const denied = { organizationPermissions: ['org:sources:read'] };
      const baseline = await fixture(denied);
      const f = await fixture({ ...denied, ...target });
      const response = await normalized(await f.request(method, path, body));
      expect(response.status).toBe(403);
      expect(response).toEqual(await normalized(await baseline.request(method, path, body)));
      for (const fixture of [f, baseline]) {
        expect(fixture.sources.get).not.toHaveBeenCalled();
        expect(fixture.update).not.toHaveBeenCalled();
        expect(fixture.pause).not.toHaveBeenCalled();
        expect(fixture.resume).not.toHaveBeenCalled();
        expect(fixture.sessions.authenticate).not.toHaveBeenCalled();
        expect(fixture.credentials.prepare).not.toHaveBeenCalled();
      }
    },
  );
});

describe.each(mutations)('project source %s %s', (method, suffix, body) => {
  const path = `/_pb/projects/demo/sources/${SOURCE}${suffix}`;
  const writer = { organizationPermissions: [], projectPermissions: ['project:sources:write'] };

  it('reaches the owned-source mutation with write permission alone', async () => {
    const f = await fixture({ ...writer, sourceProject: PROJECT });
    expect((await f.request(method, path, body)).status).toBe(
      suffix === '/resume' ? 409 : suffix === '/sync' ? 202 : 204,
    );
    expect(f.getVisible).toHaveBeenCalledOnce();
    expect(f.sources.getVisible).toHaveBeenCalledExactlyOnceWith(orgContext('org-1'), {
      projectId: PROJECT,
      sourceId: SOURCE,
    });
    const operation =
      suffix === '/sync'
        ? f.syncNow
        : suffix === '/resume'
          ? f.resume
          : suffix === '/pause'
            ? f.pause
            : f.update;
    expect(operation).toHaveBeenCalledOnce();
  });

  it.each([
    ['existing', { sourceProject: PROJECT }],
    ['absent', { sourceAbsent: true }],
    ['foreign', { sourceProject: OTHER_PROJECT }],
    ['invisible', { sourceProject: null, sourceAttached: false }],
  ] as const)(
    'denies an %s target identically before lookup without write permission',
    async (_state, target) => {
      const denied = { organizationPermissions: [], projectPermissions: ['project:read'] };
      const baseline = await fixture({ ...denied, sourceProject: PROJECT });
      const f = await fixture({ ...denied, ...target });
      const response = await normalized(await f.request(method, path, body));
      expect(response.status).toBe(403);
      expect(response).toEqual(await normalized(await baseline.request(method, path, body)));
      expect(f.getVisible).not.toHaveBeenCalled();
      expect(f.sources.getVisible).not.toHaveBeenCalled();
      expect(f.sources.get).not.toHaveBeenCalled();
      expect(f.projects.get).not.toHaveBeenCalled();
      expect(f.update).not.toHaveBeenCalled();
      expect(f.pause).not.toHaveBeenCalled();
      expect(f.resume).not.toHaveBeenCalled();
      expect(f.sessions.authenticate).not.toHaveBeenCalled();
      expect(f.credentials.prepare).not.toHaveBeenCalled();
    },
  );

  it('denies an attached organization source with the generic 403 before mutation or reauthentication', async () => {
    const f = await fixture({
      ...writer,
      sourceProject: null,
      sourceAttached: true,
      reauth: false,
    });
    const denied = await fixture({
      organizationPermissions: [],
      projectPermissions: ['project:read'],
    });
    const response = await normalized(await f.request(method, path, body));
    expect(response.status).toBe(403);
    expect(response).toEqual(await normalized(await denied.request(method, path, body)));
    expect(f.getVisible).toHaveBeenCalledOnce();
    expect(f.sources.list).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.sources.update).not.toHaveBeenCalled();
    expect(f.sources.pause).not.toHaveBeenCalled();
    expect(f.sources.resume).not.toHaveBeenCalled();
    expect(f.sessions.authenticate).not.toHaveBeenCalled();
    expect(f.sessions.isReauthFresh).not.toHaveBeenCalled();
    expect(f.credentials.prepare).not.toHaveBeenCalled();
  });

  it.each([
    ['absent source', { sourceAbsent: true }],
    ['foreign source', { sourceProject: OTHER_PROJECT }],
    ['unattached organization source', { sourceProject: null }],
    ['absent project', { projectState: 'absent' }],
    ['foreign project', { projectState: 'foreign' }],
    ['archived project', { projectState: 'archived' }],
    ['invisible project', { projectState: 'invisible' }],
  ] as const)(
    'hides an %s with the uniform 404 when write permission is held',
    async (_state, target) => {
      const baseline = await fixture({ ...writer, sourceAbsent: true });
      const f = await fixture({ ...writer, sourceProject: PROJECT, ...target });
      const response = await normalized(await f.request(method, path, body));
      expect(response.status).toBe(404);
      expect(response).toEqual(await normalized(await baseline.request(method, path, body)));
      expect(f.update).not.toHaveBeenCalled();
      expect(f.pause).not.toHaveBeenCalled();
      expect(f.resume).not.toHaveBeenCalled();
      expect(f.sessions.authenticate).not.toHaveBeenCalled();
    },
  );
});

it('guards project source listing if the project is archived after authorization', async () => {
  const f = await fixture({ archivedAfterAuthorization: true });
  const absent = await fixture({ projectState: 'absent' });
  const path = '/_pb/projects/demo/sources';
  const response = await normalized(await f.request('GET', path));
  expect(response.status).toBe(404);
  expect(response).toEqual(await normalized(await absent.request('GET', path)));
  expect(f.projects.get).toHaveBeenCalledExactlyOnceWith(orgContext('org-1'), PROJECT);
  expect(await f.projects.get.mock.results[0]?.value).toMatchObject({ status: 'archived' });
  expect(f.list).not.toHaveBeenCalled();
  expect(f.sources.list).not.toHaveBeenCalled();
});

describe('POST /_pb/sources/:source/accept-removal', () => {
  const path = `/_pb/sources/${SOURCE}/accept-removal`;
  const refusal = { at: '2026-10-22T10:00:00.000Z', absent: 9, listed: 1, successful: 1 };
  it('documents conflicts with the shared error envelope', () => {
    const document = generateOpenApi([ACCEPT_REMOVAL_API_SPEC], {
      title: 'Package Broker',
      version: '2.0.0',
    });
    expect(document.paths['/_pb/sources/{source}/accept-removal']?.post?.responses).toMatchObject({
      204: { description: 'No content' },
      409: {
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
        },
      },
    });
  });

  it('returns 404 without the optional method while source reads remain available', async () => {
    const f = await fixture({ admin: true, acceptRemoval: false });
    expect((await f.request('POST', path)).status).toBe(404);
    expect(f.sources.acceptRemoval).not.toHaveBeenCalled();
    expect((await f.request('GET', '/_pb/sources')).status).toBe(200);
  });
  it('exports a schema and accepts an audited admin request without a body', async () => {
    expect(() => defineApi(ACCEPT_REMOVAL_API_SPEC)).not.toThrow();
    const f = await fixture({ admin: true, refusal });
    expect((await f.request('POST', path)).status).toBe(204);
    expect(f.sources.acceptRemoval).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 'user-1', sessionId: 'session-1', expected: {} },
      expect.objectContaining({
        id: SOURCE,
        refusal,
        audit: expect.objectContaining({ action: 'source.removal_accepted' }),
      }),
    );
  });
  it('returns conflict when the repository finds the refusal changed', async () => {
    const f = await fixture({ admin: true, refusal });
    f.sources.acceptRemoval.mockResolvedValue('conflict');
    expect((await f.request('POST', path)).status).toBe(409);
  });
  it.each([
    ['no recorded refusal', {}],
    ['a total wipe', { refusal: { ...refusal, successful: 0 } }],
    ['an armed acceptance', { refusal, armed: true }],
  ])('returns 409 for %s', async (_name, options) => {
    const f = await fixture({ admin: true, ...options });
    expect((await f.request('POST', path)).status).toBe(409);
    expect(f.sources.acceptRemoval).not.toHaveBeenCalled();
  });
  it('requires an admin even with delegated source-write permission', async () => {
    const f = await fixture({ refusal });
    expect((await f.request('POST', path)).status).toBe(403);
    expect(f.sources.acceptRemoval).not.toHaveBeenCalled();
  });
  it('returns the same 404 for missing and invisible sources', async () => {
    const missing = await fixture({ admin: true, sourceAbsent: true });
    const hidden = await fixture({ admin: true, sourceProject: PROJECT, projectState: 'archived' });
    expect(await normalized(await missing.request('POST', path))).toEqual(
      await normalized(await hidden.request('POST', path)),
    );
    expect((await hidden.request('POST', path)).status).toBe(404);
    expect(hidden.sources.acceptRemoval).not.toHaveBeenCalled();
  });
});

it('marks attachments using the complete attachment reader, preserving unattached owned sources', async () => {
  const row = {
    ...create,
    id: SOURCE,
    projectId: PROJECT,
    configJson: '{}',
    credentialId: null,
    lastError: null,
    status: 'active',
    removalPolicy: 'flag',
    pollIntervalSeconds: 300,
    lastSuccessAt: null,
    lastPolledAt: null,
    nextPollAt: null,
  } as SourceRecord;
  const f = await fixture({ rows: [row, { ...row, id: SECOND, projectId: null }] });
  const response = await f.request('GET', '/_pb/projects/demo/sources?limit=1');
  expect(response.status).toBe(200);
  const first = (await response.json()) as { items: Record<string, unknown>[] };
  expect(first).toMatchObject({ items: [{ id: SOURCE, attached: false }], next: SOURCE });
  expect(first.items[0]).not.toHaveProperty('precedence');
  const next = await f.request('GET', '/_pb/projects/demo/sources?after=' + SOURCE);
  const page = (await next.json()) as { items: Record<string, unknown>[] };
  expect(page.items[0]).toMatchObject({ id: SECOND, attached: true, precedence: 2 });
  expect(response.headers.get('etag')).toBe('"r7"');
});

it('denies source listing before handler lookups without source read permission', async () => {
  const f = await fixture({ projectPermissions: ['project:read'] });
  expect((await f.request('GET', '/_pb/projects/demo/sources')).status).toBe(403);
  expect(f.projects.get).not.toHaveBeenCalled();
  expect(f.sources.list).not.toHaveBeenCalled();
});

it.each(['absent', 'foreign', 'archived', 'invisible'] as const)(
  'hides the %s project on source reads',
  async (projectState) => {
    const f = await fixture({ projectState });
    expect((await f.request('GET', '/_pb/projects/demo/sources')).status).toBe(404);
    expect(f.sources.list).not.toHaveBeenCalled();
  },
);

it.each(['organization', 'project', 'all'] as const)(
  'passes organization ownership %s through with stable pagination',
  async (ownership) => {
    const f = await fixture();
    const response = await f.request(
      'GET',
      `/_pb/sources?ownership=${ownership}&limit=1&after=${SECOND}`,
    );
    expect(response.status).toBe(200);
    expect(f.sources.list.mock.calls[0]?.[1]).toEqual({
      projectId: null,
      ownership,
      after: SECOND,
      limit: 1,
      ...(ownership === 'organization'
        ? {}
        : {
            projectVisibility: {
              userId: 'user-1',
              allProjects: false,
              includeArchived: false,
              providerAnchors: [],
            },
          }),
    });
  },
);

it.each(['project', 'all'] as const)(
  'passes a capped PAT visibility into %s ownership reads',
  async (ownership) => {
    const f = await fixture({
      tokenProjectMode: 'selected',
      tokenProjectIds: [PROJECT],
      tokenInherited: true,
      tokenAdmin: true,
    });
    expect(
      (await f.request('GET', `/_pb/sources?ownership=${ownership}`, undefined, true)).status,
    ).toBe(200);
    expect(f.sources.list.mock.calls[0]?.[1]).toMatchObject({
      ownership,
      projectVisibility: {
        userId: 'user-1',
        restrictTo: [PROJECT],
        allProjects: true,
        includeArchived: false,
        providerAnchors: [],
      },
    });
  },
);

it('rejects unknown ownership and ownership on the project route', async () => {
  const f = await fixture();
  expect((await f.request('GET', '/_pb/sources?ownership=unknown')).status).toBe(400);
  expect((await f.request('GET', '/_pb/projects/acme/sources?ownership=all')).status).toBe(400);
  expect(f.sources.list).not.toHaveBeenCalled();
});

it.each([undefined, 'organization', 'project', 'all'] as const)(
  'returns the expected rows for ownership %s',
  async (ownership) => {
    const base = {
      ...create,
      configJson: '{}',
      credentialId: null,
      status: 'paused',
      removalPolicy: 'flag',
      pollIntervalSeconds: 60,
      lastSuccessAt: null,
      lastPolledAt: null,
      nextPollAt: null,
    };
    const rows = [
      { ...base, id: SOURCE, projectId: null },
      { ...base, id: SECOND, projectId: PROJECT, projectName: 'Payments' },
    ] as SourceRecord[];
    const f = await fixture({ rows });
    const query = ownership === undefined ? '' : `&ownership=${ownership}`;
    const first = await f.request('GET', `/_pb/sources?limit=1${query}`);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      items: [
        {
          id: ownership === 'project' ? SECOND : SOURCE,
          projectName: ownership === 'project' ? 'Payments' : null,
        },
      ],
      next: ownership === 'all' ? SOURCE : null,
    });
    if (ownership === 'all') {
      const second = await f.request('GET', `/_pb/sources?limit=1&ownership=all&after=${SOURCE}`);
      expect(await second.json()).toMatchObject({
        items: [{ id: SECOND, projectId: PROJECT, projectName: 'Payments' }],
        next: null,
      });
    }
  },
);
it.each(['project', 'all'])(
  'retains organization read authority for ownership %s',
  async (ownership) => {
    const f = await fixture({ organizationPermissions: [] });
    expect((await f.request('GET', `/_pb/sources?ownership=${ownership}`)).status).toBe(403);
    expect(f.sources.list).not.toHaveBeenCalled();
  },
);

it('returns proxy conflicts as structured claims with a stable error envelope', async () => {
  const f = await fixture();
  f.createSource.mockResolvedValue({
    ok: false,
    error: 'conflict',
    conflictingClaims: ['widget', '@scope/name'],
  });
  const response = await f.request('POST', '/_pb/sources', {
    name: 'Public registry',
    ecosystem: 'npm',
    type: 'npmjs_proxy',
    url: 'https://registry.npmjs.org',
  });
  expect(response.status).toBe(409);
  const body = (await response.json()) as { error: unknown };
  expect(body).toMatchObject({
    error: { code: 'conflict', requestId: expect.any(String) },
    conflictingClaims: ['widget', '@scope/name'],
  });
  expect(JSON.stringify(body.error)).not.toContain('widget');
  expect(response.headers.get('cache-control')).toBe('no-store');
});
