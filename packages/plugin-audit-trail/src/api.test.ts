import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sha256Hex } from '@package-broker/core/auth/primitives';
import {
  createAuthorizationEngine,
  patValidationGate,
  type EngineAccessPort,
} from '@package-broker/core/authz/engine';
import type { AuditRow } from '@package-broker/core/audit/chain';
import { orgContext } from '@package-broker/core/db/port';
import type { RequestContext } from '@package-broker/core/plugin';
type AuditTrailServices = AuditTrailDispatch['services'];
import { validateAuditBuild, resolveOrgAudit } from '@package-broker/core/audit/effective';
import { fixedClock } from '@package-broker/core/ids';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import { createKernel } from '@package-broker/core/kernel/kernel';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { auditRoutes, type AuditTrailDispatch } from '@package-broker/core/api/routes/audit';

import { auditTrail } from './index.js';

beforeEach(() => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
});
afterEach(() => {
  vi.restoreAllMocks();
});

const ID = '01JA0000000000000000000000';
const SECRET = 'A'.repeat(43);
const SENTINEL = 'S3CR3T-SENTINEL';
const paths = ['/_pb/audit', '/_pb/audit/head', '/_pb/projects/demo/audit'];
const row = (projectId: string | null): AuditRow => ({
  id: ID,
  org_id: 'org-1',
  seq: 1,
  prev_hash: '0'.repeat(64),
  hash: '1'.repeat(64),
  created_at: '2026-10-16T00:00:00.000Z',
  actor_type: 'user',
  actor_id: 'user-1',
  token_selector: null,
  source_ip: '192.0.2.10',
  action: 'project.update',
  target_type: 'project',
  target_id: projectId,
  project_id: projectId,
  payload_json: JSON.stringify({ op_id: ID, request_id: ID, changes: { name: { new: 'Demo' } } }),
});

async function fixture(
  options: {
    orgId?: string;
    stub?: boolean;
    dispatch?: AuditTrailDispatch;
    permissions?: string[];
    rows?: (AuditRow | import('@package-broker/core/audit/plugin-api').AuditWithheldMarkerV1)[];
    projects?: {
      id: string;
      slug: string;
      orgId: string;
      archived: boolean;
      visible: boolean;
    }[];
  } = {},
) {
  const list = vi.fn<AuditTrailServices['journal']['list']>((ctx, query) =>
    Promise.resolve({
      items: (options.rows ?? [row('project-a'), row('project-b'), row(null)])
        .filter((item) => ('org_id' in item ? item.org_id : item.orgId) === ctx.orgId)
        .filter(
          (item) =>
            query.projectId === null ||
            ('project_id' in item
              ? item.project_id
              : 'projectId' in item
                ? item.projectId
                : null) === query.projectId,
        )
        .map((item) =>
          'kind' in item
            ? item
            : {
                kind: 'event' as const,
                schemaVersion: 1 as const,
                chainId: 'chain',
                epoch: 1,
                id: item.id,
                orgId: item.org_id,
                seq: item.seq,
                prevHash: item.prev_hash,
                hash: item.hash,
                createdAt: item.created_at,
                actorType: item.actor_type,
                actorId: item.actor_id,
                tokenSelector: item.token_selector,
                sourceIp: item.source_ip,
                action: item.action,
                targetType: item.target_type,
                targetId: item.target_id,
                projectId: item.project_id,
                payloadJson: item.payload_json,
              },
        ),
      next: 1,
    }),
  );
  const head = vi.fn<AuditTrailServices['journal']['head']>(() =>
    Promise.resolve({
      chainId: 'chain',
      epoch: 1,
      headSeq: 1,
      headHash: '1'.repeat(64),
      boundarySeq: 1,
      boundaryPrevHash: '0'.repeat(64),
      pendingCount: 2,
      verification: null,
    }),
  );
  const permissions = options.permissions ?? ['org:audit:read', 'project:audit:read'];
  const projects = options.projects ?? [
    { id: 'project-a', slug: 'demo', orgId: 'org-1', archived: false, visible: true },
  ];
  const lookupSession = vi.fn<EngineAccessPort['lookupSession']>(async (ctx, input) => {
    if (input.secretHash !== (await sha256Hex(SECRET))) return null;
    const project = projects.find(
      (candidate) =>
        input.boundary === 'project' &&
        candidate.slug === input.projectSlug &&
        candidate.orgId === ctx.orgId &&
        !candidate.archived,
    );
    return {
      session: { id: 'session-1', csrfHash: '' },
      user: { id: 'user-1' },
      identity: null,
      protectedHolder: false,
      project: project ? { id: project.id } : null,
      organizationPermissions: permissions.filter((p) => p.startsWith('org:')),
      projectPermissions: project?.visible
        ? ['project:read', ...permissions.filter((p) => p.startsWith('project:'))]
        : [],
    };
  });
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: auditRoutes(
      options.stub
        ? undefined
        : (options.dispatch ?? {
            trail: { definition: auditTrail().auditTrail! },
            effective: async () => ({ trailActive: true, policy: 'availability' as const }),
            services: { journal: { list, head }, requestVerification: async () => undefined },
            log: () => undefined,
          }),
    ),
    ports: {
      organizations: { get: () => Promise.resolve(null) },
      clock: fixedClock('2026-10-16T00:00:00.000Z'),
      ids: { ulid: () => ID },
    },
    resolveOrg: () => Promise.resolve(orgContext(options.orgId ?? 'org-1')),
    health: () => Promise.resolve(true),
    log: () => undefined,
    authorization: createAuthorizationEngine({
      access: {
        lookupSession,
        lookupToken: () => Promise.resolve(null),
        touchSession: () => Promise.resolve(true),
        touchToken: () => Promise.resolve(true),
      },
      tokenUse: {
        keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]),
        nowMs: () => 0,
        dispatch: () => undefined,
        log: () => undefined,
      },
      patValidation: patValidationGate,
      publicOrigin: 'https://broker.test',
      providerAnchors: () => Promise.resolve([]),
    }),
  });
  const request = (path = paths[0]!, cookie: string | null = SECRET) =>
    kernel.fetch(
      new Request(`https://broker.test${path}`, {
        headers: {
          'x-request-id': '11111111-1111-4111-8111-111111111111',
          ...(cookie === null ? {} : { cookie: `__Host-pb_session=${cookie}` }),
        },
      }),
    );
  return { request, list, head, lookupSession };
}

async function error(response: Response) {
  return (await response.json()) as {
    error: { code: string; details?: { path: string; code: string }[] };
  };
}

for (const [cause, cookie] of [
  ['missing', null],
  ['malformed', 'bad'],
  ['wrong secret', 'B'.repeat(43)],
] as const) {
  it(`rejects ${cause} credentials uniformly`, async () => {
    const f = await fixture();
    const response = await f.request(paths[0], cookie);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(await (await f.request(paths[0], null)).text());
    expect(f.list).not.toHaveBeenCalled();
  });
}
for (const path of paths) {
  it(`denies missing permission on ${path} uniformly`, async () => {
    const f = await fixture({ permissions: [] });
    const response = await f.request(path);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(await (await f.request(paths[0])).text());
    expect(f.list).not.toHaveBeenCalled();
    expect(f.head).not.toHaveBeenCalled();
  });
}
for (const path of paths.slice(0, 2)) {
  it(`denies project-only permission on ${path}`, async () => {
    const f = await fixture({ permissions: ['project:audit:read'] });
    expect((await f.request(path)).status).toBe(403);
  });
}
it('hides absent, foreign, archived and invisible projects uniformly', async () => {
  const f = await fixture({
    permissions: ['org:audit:read'],
    projects: [
      { id: 'project-foreign', slug: 'foreign', orgId: 'org-2', archived: false, visible: true },
      { id: 'project-archived', slug: 'archived', orgId: 'org-1', archived: true, visible: true },
      {
        id: 'project-invisible',
        slug: 'invisible',
        orgId: 'org-1',
        archived: false,
        visible: false,
      },
    ],
  });
  const responses: Response[] = [];
  for (const id of ['absent', 'foreign', 'archived', 'invisible']) {
    responses.push(await f.request(`/_pb/projects/${id}/audit`));
  }
  const dumps = await Promise.all(
    responses.map(async (r) => {
      expect(r.status).toBe(404);
      return JSON.stringify({
        status: r.status,
        headers: [...r.headers].filter(([key]) => key !== 'x-request-id'),
        body: await r.text(),
      });
    }),
  );
  expect(new Set(dumps).size).toBe(1);
  expect(f.lookupSession.mock.calls.map(([ctx, input]) => [ctx.orgId, input.projectSlug])).toEqual([
    ['org-1', 'absent'],
    ['org-1', 'foreign'],
    ['org-1', 'archived'],
    ['org-1', 'invisible'],
  ]);
  const access = await Promise.all(f.lookupSession.mock.results.map((result) => result.value));
  expect(access.map((result) => result?.project)).toEqual([
    null,
    null,
    null,
    { id: 'project-invisible' },
  ]);
  expect(access[3]?.projectPermissions).toEqual([]);
  expect(f.list).not.toHaveBeenCalled();
});
for (const [cause, query] of [
  ['unknown', `?${SENTINEL}=x`],
  ['wrong type', `?actor=${SENTINEL}&actor=x`],
  ['overlong', `?actor=${SENTINEL.repeat(30)}`],
  ['project override', `?project=${SENTINEL}`],
] as const) {
  it(`rejects ${cause} without reflecting input`, async () => {
    const f = await fixture();
    const r = await f.request(paths[2]! + query);
    expect(r.status).toBe(400);
    const body = await error(r);
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.details?.length).toBeGreaterThan(0);
    for (const detail of body.error.details ?? [])
      expect(Object.keys(detail).sort()).toEqual(['code', 'path']);
    expect(JSON.stringify(body)).not.toContain(SENTINEL);
    expect(f.list).not.toHaveBeenCalled();
  });
}
it('passes only the resolved project and returns its rows', async () => {
  const f = await fixture();
  const response = await f.request(paths[2]);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ items: [{ projectId: 'project-a' }], next: '1' });
  expect(f.list.mock.calls[0]?.[1]).toEqual({ projectId: 'project-a', limit: 50 });
});
it('forwards exact filters and cursor on the organization list', async () => {
  const f = await fixture();
  await f.request(
    `/_pb/audit?project=project-a&actor=user-1&action=project.update&after=1&limit=200`,
  );
  expect(f.list.mock.calls[0]?.[1]).toEqual({
    projectId: 'project-a',
    actor: 'user-1',
    action: 'project.update',
    afterSeq: 1,
    limit: 200,
  });
});
it('rejects limit 201 with too_big', async () => {
  const f = await fixture();
  const r = await f.request('/_pb/audit?limit=201');
  expect(r.status).toBe(400);
  expect((await error(r)).error.details).toContainEqual({ path: '/query/limit', code: 'too_big' });
});
for (const limit of ['0', '-1', '1.5', SENTINEL]) {
  it(`rejects invalid limit ${limit}`, async () => {
    const f = await fixture();
    expect((await f.request(`/_pb/audit?limit=${limit}`)).status).toBe(400);
  });
}
it('returns head metadata', async () => {
  const f = await fixture();
  expect(await (await f.request(paths[1])).json()).toEqual({
    seq: 1,
    hash: '1'.repeat(64),
    pendingCount: 2,
    lastVerifiedAt: null,
  });
});
it('serializes only public row fields and allowlisted payload', async () => {
  const f = await fixture();
  const body = (await (await f.request()).json()) as { items: Record<string, unknown>[] };
  for (const item of body.items) {
    expect(Object.keys(item).sort()).toEqual(
      [
        'id',
        'seq',
        'action',
        'actor',
        'targetType',
        'targetId',
        'projectId',
        'createdAt',
        'payload',
      ].sort(),
    );
    expect(JSON.stringify(item)).not.toContain('source_ip');
    expect(JSON.stringify(item)).not.toContain('192.0.2.10');
    expect(item.payload).toEqual({ op_id: ID, request_id: ID, changes: { name: { new: 'Demo' } } });
  }
});
for (const payload of [
  '{',
  'null',
  '[]',
  JSON.stringify({
    op_id: ID,
    request_id: ID,
    changes: { name: { new: SENTINEL + '@example.test' } },
  }),
  JSON.stringify({ secret: SENTINEL }),
  JSON.stringify({ op_id: ID, request_id: ID, secret: SENTINEL }),
  JSON.stringify({ op_id: ID, request_id: ID, changes: { password: { to: SENTINEL } } }),
  JSON.stringify({ op_id: ID, request_id: ID, extra: 'x'.repeat(4096) }),
]) {
  it(`keeps unsafe legacy payload unavailable without a composed trail ${payload.length}`, async () => {
    const f = await fixture({ stub: true, rows: [{ ...row(null), payload_json: payload }] });
    const response = await f.request();
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(SENTINEL);
    expect(f.list).not.toHaveBeenCalled();
  });
}
for (const success of [true, false]) {
  it(`sets private response headers on ${success ? 'success' : 'error'}`, async () => {
    const f = await fixture();
    const r = await f.request(paths[0], success ? SECRET : null);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect([...r.headers.keys()].some((key) => key.startsWith('access-control-'))).toBe(false);
  });
}

it('accepts limit 200', async () => {
  const f = await fixture();
  expect((await f.request('/_pb/audit?limit=200')).status).toBe(200);
  expect(f.list.mock.calls[0]?.[1].limit).toBe(200);
});

it('refuses a project handler without a resolved project', async () => {
  const trail = trailDispatch();
  const route = auditRoutes(trail.dispatch)[2]!;
  const response = await route.handler({
    request: new Request('https://broker.test/_pb/projects/demo/audit'),
    params: { project: 'demo' },
    projectId: null,
    requestId: ID,
  } as unknown as RequestContext);
  expect(response.status).toBe(404);
  expect(trail.create).not.toHaveBeenCalled();
});

it.each(['/_pb/audit', '/_pb/audit/head', '/_pb/projects/demo/audit'])(
  'returns the unavailable trail stub for %s without reading the journal',
  async (path) => {
    const f = await fixture({ stub: true });
    const response = await f.request(path);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'audit_trail_unavailable' } });
    expect(f.list).not.toHaveBeenCalled();
    expect(f.head).not.toHaveBeenCalled();
  },
);

function trailDispatch(active = true, policy: 'availability' | 'required' = 'availability') {
  const services = {
    journal: {
      list: vi.fn<AuditTrailServices['journal']['list']>(async () => ({ items: [], next: null })),
      head: vi.fn<AuditTrailServices['journal']['head']>(async () => ({
        chainId: 'chain',
        epoch: 1,
        headSeq: 7,
        headHash: 'a'.repeat(64),
        boundarySeq: 1,
        boundaryPrevHash: '0'.repeat(64),
        pendingCount: 2,
        verification: null,
      })),
    },
    requestVerification: vi.fn(async () => undefined),
  };
  const handle = vi.fn<import('@package-broker/core/audit/plugin-api').AuditTrail['handle']>(
    async () => ({
      items: [],
      next: null,
    }),
  );
  const create = vi.fn((ctx: import('@package-broker/core/audit/plugin-api').AuditTrailContext) => {
    handle.mockImplementation(async (...args) => {
      const [operation] = args;
      if (operation !== 'auditHead') return { items: [], next: null };
      const head = await ctx.journal.head();
      return {
        seq: head.headSeq,
        hash: head.headHash,
        pendingCount: head.pendingCount,
        lastVerifiedAt: null,
      };
    });
    return { handle };
  });
  const registration = collectRegistrations([
    {
      id: 'trail',
      package: '@test/trail',
      apiVersion: 4,
      platforms: ['node'],
      binds: ['audit-trail'],
      auditTrail: { toggleEnv: 'PB_AUDIT_TRAIL', create },
    },
  ]);
  const dispatch: AuditTrailDispatch = {
    log: vi.fn(),
    trail: registration.audit.trail,
    effective: vi.fn(async () => ({ policy, trailActive: active })),
    services,
  };
  return { dispatch, create, handle, services };
}

it.each([
  [
    paths[0] + '?actor=user-1&limit=3&project=project-b',
    'listAudit',
    { query: { actor: 'user-1', limit: '3', project: 'project-b' }, projectId: 'project-b' },
  ],
  [paths[1], 'auditHead', { query: undefined, projectId: null }],
  [
    paths[2] + '?action=project.update',
    'listProjectAudit',
    { query: { action: 'project.update' }, projectId: 'project-a' },
  ],
] as const)('dispatches a registered trail on %s', async (path, operation, request) => {
  const trail = trailDispatch();
  const f = await fixture({ dispatch: trail.dispatch });
  expect((await f.request(path)).status).toBe(200);
  expect(trail.handle).toHaveBeenCalledWith(operation, request);
  expect(trail.create.mock.calls[0]?.[0].active).toBe(true);
  expect(trail.dispatch.effective).toHaveBeenCalledWith(orgContext('org-1'));
  expect(f.list).not.toHaveBeenCalled();
  expect(f.head).not.toHaveBeenCalled();
  if (operation === 'auditHead')
    expect(trail.services.journal.head).toHaveBeenCalledWith(orgContext('org-1'));
  expect(trail.services.requestVerification).not.toHaveBeenCalled();
});

it.each(paths)('refuses an inactive trail on %s without falling back', async (path) => {
  const trail = trailDispatch(false);
  const f = await fixture({ dispatch: trail.dispatch });
  const response = await f.request(path);
  expect(response.status).toBe(404);
  expect((await error(response)).error.code).toBe('audit_trail_unavailable');
  expect(trail.create).not.toHaveBeenCalled();
  expect(f.list).not.toHaveBeenCalled();
  expect(f.head).not.toHaveBeenCalled();
});

it('ignores the disabled trail toggle under required policy', async () => {
  const trail = trailDispatch(false, 'required');
  const build = validateAuditBuild(
    {
      platform: 'cloudflare',
      plugins: [
        {
          id: 'trail',
          package: '@test/trail',
          apiVersion: 4,
          platforms: ['cloudflare'],
          binds: ['audit-trail'],
          auditTrail: trail.dispatch.trail!.definition,
        },
      ],
      audit: { policy: 'required', alerts: { webhookEnv: 'AUDIT_ALERT_URL' } },
    },
    (name) => (name === 'PB_AUDIT_TRAIL' ? 'off' : undefined),
    'cloudflare',
  );
  const result = resolveOrgAudit({ build, storedPolicy: null, sinks: [], alertPathActive: true });
  if (!result.ok) throw new Error('Expected effective configuration');
  trail.dispatch = { ...trail.dispatch, effective: async () => result.effective };
  const f = await fixture({ dispatch: trail.dispatch });
  expect((await f.request(paths[1])).status).toBe(200);
  expect(trail.create.mock.calls[0]?.[0].active).toBe(true);
  expect(trail.services.journal.head).toHaveBeenCalledWith(orgContext('org-1'));
});

it('keeps authorization ahead of trail creation', async () => {
  const trail = trailDispatch();
  const f = await fixture({ dispatch: trail.dispatch, permissions: [] });
  for (const path of paths) expect((await f.request(path)).status).toBe(403);
  expect(trail.create).not.toHaveBeenCalled();
  expect(trail.dispatch.effective).not.toHaveBeenCalled();
});

it('refuses a missing composed trail', async () => {
  const trail = trailDispatch();
  const f = await fixture({ dispatch: { ...trail.dispatch, trail: null } });
  expect((await f.request(paths[0])).status).toBe(404);
  expect(f.list).not.toHaveBeenCalled();
  expect(trail.create).not.toHaveBeenCalled();
});

it('keeps concurrent organization list and head requests bound to their own contexts', async () => {
  const trail = trailDispatch();
  trail.create.mockImplementation((ctx) => ({
    handle: vi.fn<import('@package-broker/core/audit/plugin-api').AuditTrail['handle']>(
      async (...[operation, request]) => {
        if (operation === 'auditHead') {
          const head = await ctx.journal.head();
          return {
            seq: head.headSeq,
            hash: head.headHash,
            pendingCount: head.pendingCount,
            lastVerifiedAt: null,
          };
        }
        await ctx.journal.list({ projectId: request.projectId, limit: 50 });
        return { items: [], next: null };
      },
    ),
  }));
  const a = await fixture({ orgId: 'org-a', dispatch: trail.dispatch });
  const b = await fixture({ orgId: 'org-b', dispatch: trail.dispatch });
  const responses = await Promise.all([
    a.request(paths[0]),
    b.request(paths[0]),
    a.request(paths[1]),
    b.request(paths[1]),
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
  expect(
    [...trail.services.journal.list.mock.calls].sort(([a], [b]) => a.orgId.localeCompare(b.orgId)),
  ).toEqual([
    [orgContext('org-a'), { projectId: null, limit: 50 }],
    [orgContext('org-b'), { projectId: null, limit: 50 }],
  ]);
  expect(
    [...trail.services.journal.head.mock.calls].sort(([a], [b]) => a.orgId.localeCompare(b.orgId)),
  ).toEqual([[orgContext('org-a')], [orgContext('org-b')]]);
});

it.each([
  new Error(SENTINEL),
  { ok: false as const, code: 'alert_path_required' as const, persistRaise: false, data: SENTINEL },
])('fences failed or refused effective configuration with one fixed log', async (failure) => {
  const trail = trailDispatch();
  trail.dispatch = {
    ...trail.dispatch,
    effective: async () => {
      if (failure instanceof Error) throw failure;
      return failure;
    },
  };
  const f = await fixture({ dispatch: trail.dispatch });
  const response = await f.request();
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain(SENTINEL);
  expect(trail.dispatch.log).toHaveBeenCalledExactlyOnceWith({
    level: 'error',
    event: 'audit.effective_unavailable',
    reason_code: 'audit.effective_unavailable',
  });
  expect(trail.create).not.toHaveBeenCalled();
});

it('rejects extra trail response fields without exposing body data', async () => {
  const trail = trailDispatch();
  trail.create.mockImplementation(() => ({
    handle: vi.fn(async () => ({ items: [], next: null, payloadJson: SENTINEL })),
  }));
  const f = await fixture({ dispatch: trail.dispatch });
  const response = await f.request();
  expect(response.status).toBe(500);
  const body = await response.text();
  expect(JSON.parse(body)).toMatchObject({ error: { code: 'audit_trail_invalid_response' } });
  expect(body).not.toContain(SENTINEL);
});

it.each([paths[0], paths[2]])(
  'keeps withheld items minimal through the composed trail %s',
  async (path) => {
    const f = await fixture({
      rows: [
        {
          kind: 'withheld',
          markerId: 'marker',
          reasonCode: 'content_unavailable',
          chainId: 'chain',
          epoch: 1,
          orgId: 'org-1',
          seq: 7,
          prevHash: '0'.repeat(64),
          hash: 'a'.repeat(64),
          id: ID,
          createdAt: SENTINEL,
          actorType: 'system',
          actorId: SENTINEL,
          action: SENTINEL,
          targetType: 'project',
          targetId: 'project-a',
          projectId: 'project-a',
        },
      ],
    });
    const response = await f.request(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [{ kind: 'withheld', id: ID, seq: 7, reason: 'content' }],
      next: '1',
    });
  },
);
it('keeps unreadable items minimal through the composed trail', async () => {
  const f = await fixture({
    rows: [
      {
        kind: 'withheld',
        markerId: 'marker',
        reasonCode: 'unreadable',
        chainId: 'chain',
        epoch: 1,
        orgId: 'org-1',
        seq: 7,
        prevHash: '0'.repeat(64),
        hash: 'a'.repeat(64),
      },
    ],
  });
  expect(await (await f.request()).json()).toEqual({
    items: [{ kind: 'withheld', id: 'marker', seq: 7, reason: 'unreadable' }],
    next: '1',
  });
});

it('does not override an inactive effective trail under required policy', async () => {
  const trail = trailDispatch(false, 'required');
  const f = await fixture({ dispatch: trail.dispatch });
  expect((await f.request()).status).toBe(404);
  expect(trail.create).not.toHaveBeenCalled();
});
