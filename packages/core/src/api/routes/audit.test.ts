import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../auth/primitives.js';
import {
  createAuthorizationEngine,
  patValidationGate,
  type EngineAccessPort,
} from '../../authz/engine.js';
import type { AuditRow } from '../../audit/chain.js';
import { orgContext } from '../../db/port.js';
import type { RequestContext } from '../../plugin.js';
import { fixedClock } from '../../ids.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { auditRoutes, type AuditReader } from './audit.js';

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
    permissions?: string[];
    rows?: AuditRow[];
    projects?: {
      id: string;
      slug: string;
      orgId: string;
      archived: boolean;
      visible: boolean;
    }[];
  } = {},
) {
  const list = vi.fn<AuditReader['list']>((ctx, query) =>
    Promise.resolve({
      items: (options.rows ?? [row('project-a'), row('project-b'), row(null)])
        .filter((item) => item.org_id === ctx.org?.orgId)
        .filter((item) => query.projectId === null || item.project_id === query.projectId),
      next: ID,
    }),
  );
  const head = vi.fn<AuditReader['head']>(() =>
    Promise.resolve({ seq: 1, hash: '1'.repeat(64), pendingCount: 2, lastVerifiedAt: null }),
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
    coreRoutes: auditRoutes({ list, head }),
    ports: {
      organizations: { get: () => Promise.resolve(null) },
      clock: fixedClock('2026-10-16T00:00:00.000Z'),
      ids: { ulid: () => ID },
    },
    resolveOrg: () => Promise.resolve(orgContext('org-1')),
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
  expect(await response.json()).toMatchObject({ items: [{ projectId: 'project-a' }], next: ID });
  expect(f.list.mock.calls[0]?.[1]).toEqual({ projectId: 'project-a', limit: 50 });
});
it('forwards exact filters and cursor on the organization list', async () => {
  const f = await fixture();
  await f.request(
    `/_pb/audit?project=project-a&actor=user-1&action=project.update&after=${ID}&limit=200`,
  );
  expect(f.list.mock.calls[0]?.[1]).toEqual({
    projectId: 'project-a',
    actor: 'user-1',
    action: 'project.update',
    after: ID,
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
  it(`fails closed on unsafe payload ${payload.length}`, async () => {
    const f = await fixture({ rows: [{ ...row(null), payload_json: payload }] });
    expect(
      ((await (await f.request()).json()) as { items: { payload: unknown }[] }).items[0]?.payload,
    ).toEqual({});
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
  const reader: AuditReader = { list: vi.fn(), head: vi.fn() };
  const route = auditRoutes(reader)[2]!;
  const response = await route.handler({
    request: new Request('https://broker.test/_pb/projects/demo/audit'),
    params: { project: 'demo' },
    projectId: null,
    requestId: ID,
  } as unknown as RequestContext);
  expect(response.status).toBe(404);
  expect(reader.list).not.toHaveBeenCalled();
});
