import { expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../auth/cookies.js';
import { sha256Hex } from '../../auth/primitives.js';
import { createAuthorizationEngine, patValidationGate } from '../../authz/engine.js';
import {
  PackageAccessRequestError,
  type PackageAccessRequest,
  type PackageAccessRequestRepository,
} from '../../db/publishes.js';
import { orgContext } from '../../db/port.js';
import { fixedClock } from '../../ids.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { generateOpenApi } from '../openapi.js';
import {
  PACKAGE_ACCESS_REQUEST_SCHEMAS,
  packageAccessRequest,
  PACKAGE_ACCESS_REQUEST_API_SPECS,
} from './package-access-requests-schemas.js';
import { packageAccessRequestRoutes } from './package-access-requests.js';
const ORIGIN = 'https://broker.test';
const ID = '01JA0000000000000000000001';
const PACKAGE = '01JA0000000000000000000002';
const USER = '01JA0000000000000000000003';
const SECRET = 'A'.repeat(43),
  CSRF = 'B'.repeat(43);
const now = '2026-10-30T00:00:00.000Z';
const row: PackageAccessRequest = {
  id: ID,
  packageId: PACKAGE,
  packageName: 'widget',
  requestedBy: { type: 'user', name: 'User' },
  decidedBy: null,
  project: { id: ID, slug: 'demo', name: 'Demo' },
  projectId: ID,
  state: 'pending',
  requestedByUserId: USER,
  reason: null,
  decidedByUserId: null,
  decidedAt: null,
  decisionReason: null,
  expiresAt: '2026-11-29T00:00:00.000Z',
  revision: 1,
  createdAt: now,
  updatedAt: now,
};
async function fixture(
  permissions = [
    'project:read',
    'project:packages:manage',
    'org:packages:read',
    'org:packages:manage',
  ],
) {
  const repository = {
    get: vi.fn<PackageAccessRequestRepository['get']>().mockResolvedValue(row),
    list: vi
      .fn<PackageAccessRequestRepository['list']>()
      .mockResolvedValue({ items: [row], next: null }),
    request: vi.fn<PackageAccessRequestRepository['request']>().mockResolvedValue(row),
    decide: vi
      .fn<PackageAccessRequestRepository['decide']>()
      .mockResolvedValue({ changed: true, revision: 2 }),
    requestable: vi.fn<PackageAccessRequestRepository['requestable']>().mockResolvedValue({
      items: [{ id: PACKAGE, name: 'widget', newProjectAccessMode: 'request' }],
      next: null,
    }),
    due: vi.fn<PackageAccessRequestRepository['due']>().mockResolvedValue([]),
  };
  const clock = fixedClock(now),
    ids = { ulid: () => ID },
    log = vi.fn();
  const routes = packageAccessRequestRoutes({ repository, clock, ids, clientIp: () => null });
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: routes,
    packageResolver: { resolve: async () => ({ kind: 'absent' as const }) },
    ports: { organizations: { get: async () => null }, clock, ids },
    resolveOrg: async () => orgContext('org-1'),
    health: async () => true,
    log,
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async (_org, input) => ({
          session: { id: 'session-1', csrfHash: await sha256Hex(CSRF) },
          user: { id: USER },
          identity: null,
          protectedHolder: false,
          project: input.projectSlug === 'demo' ? { id: ID } : null,
          organizationPermissions: permissions.filter((p) => p.startsWith('org:')),
          projectPermissions: permissions.filter((p) => p.startsWith('project:')),
        }),
        lookupToken: async () => null,
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: {
        keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]),
        nowMs: () => clock.now().getTime(),
        dispatch: () => undefined,
        log,
      },
      patValidation: patValidationGate,
      publicOrigin: ORIGIN,
      providerAnchors: async () => [],
    }),
  });
  const request = (path: string, method = 'GET', body?: unknown, etag?: string) =>
    kernel.fetch(
      new Request(ORIGIN + path, {
        method,
        headers: {
          origin: ORIGIN,
          cookie: `${SESSION_COOKIE}=${SECRET}`,
          'x-csrf-token': CSRF,
          'content-type': 'application/json',
          ...(etag === undefined ? {} : { 'if-match': etag }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { request, repository, routes, log };
}
it('creates a session-owned request with thirty-day expiry and prepared audit', async () => {
  const f = await fixture();
  const response = await f.request('/_pb/projects/demo/package-access-requests', 'POST', {
    packageId: PACKAGE,
    reason: 'Needed',
  });
  expect(response.status).toBe(201);
  expect(f.repository.request).toHaveBeenCalledWith(
    orgContext('org-1'),
    expect.objectContaining({ userId: USER }),
    expect.objectContaining({
      projectId: ID,
      requestedByUserId: USER,
      expiresAt: row.expiresAt,
      event: expect.objectContaining({ action: 'package.access_request' }),
    }),
  );
});
it('lists organization requests with bounded pagination and requestable project packages', async () => {
  const f = await fixture();
  expect((await f.request('/_pb/package-access-requests?state=pending&limit=5')).status).toBe(200);
  expect(f.repository.list).toHaveBeenCalledWith(orgContext('org-1'), {
    state: 'pending',
    limit: 5,
  });
  expect((await f.request('/_pb/projects/demo/requestable-packages')).status).toBe(200);
  expect(f.repository.requestable).toHaveBeenCalledWith(orgContext('org-1'), ID, { limit: 50 });
});
it.each(['approve', 'reject'])(
  'decides %s using If-Match and the session actor',
  async (action) => {
    const f = await fixture();
    const path = `/_pb/package-access-requests/${ID}/${action}`;
    expect((await f.request(path, 'POST', { reason: 'Reviewed' })).status).toBe(428);
    expect(f.repository.decide).not.toHaveBeenCalled();
    expect((await f.request(path, 'POST', { reason: 'Reviewed' }, '"r1"')).status).toBe(200);
    expect(f.repository.decide).toHaveBeenCalledWith(
      orgContext('org-1'),
      expect.anything(),
      expect.objectContaining({
        state: action === 'approve' ? 'approved' : 'rejected',
        decidedByUserId: USER,
        expectedRevision: 1,
        event: expect.objectContaining({ action: 'package.access_decide' }),
      }),
    );
  },
);
it('reports a losing CAS as a failed precondition and stable repository failures without request data', async () => {
  const f = await fixture();
  f.repository.decide.mockResolvedValue({ changed: false, revision: 2 });
  expect(
    (await f.request(`/_pb/package-access-requests/${ID}/approve`, 'POST', {}, '"r1"')).status,
  ).toBe(412);
  f.repository.request.mockRejectedValue(new PackageAccessRequestError('conflict'));
  const response = await f.request('/_pb/projects/demo/package-access-requests', 'POST', {
    packageId: PACKAGE,
    reason: 'Needed privately',
  });
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain('Needed privately');
});
it('enforces route permissions before any repository call', async () => {
  const f = await fixture(['project:read']);
  for (const [path, method, body] of [
    ['/_pb/projects/demo/package-access-requests', 'POST', { packageId: PACKAGE }],
    ['/_pb/package-access-requests', 'GET', undefined],
    [`/_pb/package-access-requests/${ID}/approve`, 'POST', {}],
  ] as const) {
    expect((await f.request(path, method, body, '"r1"')).status).toBe(403);
  }
  expect(f.repository.request).not.toHaveBeenCalled();
  expect(f.repository.list).not.toHaveBeenCalled();
  expect(f.repository.decide).not.toHaveBeenCalled();
});
it('rejects forged actors, control characters, oversized UTF-8 reasons and unbounded lists', async () => {
  const f = await fixture();
  for (const body of [
    { packageId: PACKAGE, requestedByUserId: ID },
    { packageId: PACKAGE, reason: '\u0000' },
    { packageId: PACKAGE, reason: 'é'.repeat(501) },
  ]) {
    expect(
      (await f.request('/_pb/projects/demo/package-access-requests', 'POST', body)).status,
    ).toBe(400);
  }
  expect((await f.request('/_pb/package-access-requests?limit=51')).status).toBe(400);
  expect(
    (await f.request(`/_pb/package-access-requests/${ID}/reject`, 'POST', {}, '"r1"')).status,
  ).toBe(400);
  expect(f.repository.request).not.toHaveBeenCalled();
});
it('documents all five routes with authority and decision concurrency', async () => {
  const f = await fixture();
  expect(f.routes).toHaveLength(5);
  const doc = generateOpenApi(PACKAGE_ACCESS_REQUEST_API_SPECS, { title: 'test', version: '1' });
  expect(Object.keys(doc.paths)).toHaveLength(5);
  expect(doc.paths['/_pb/package-access-requests']?.get).toBeDefined();
});

it('accepts a full 1000-byte access reason through the audit preparation', async () => {
  const f = await fixture();
  const reason = 'Review requested. '.repeat(60).slice(0, 1000);
  expect(
    (
      await f.request('/_pb/projects/demo/package-access-requests', 'POST', {
        packageId: PACKAGE,
        reason,
      })
    ).status,
  ).toBe(201);
  expect(f.repository.request).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ reason }),
  );
});

it('uses the component body schemas in the served specs and enforces UTF-8 bytes there', () => {
  const [create, , approve, reject] = PACKAGE_ACCESS_REQUEST_API_SPECS;
  expect(create.api.body).toBe(PACKAGE_ACCESS_REQUEST_SCHEMAS.PackageAccessRequestBody);
  expect(approve.api.body).toBe(PACKAGE_ACCESS_REQUEST_SCHEMAS.PackageAccessApproveBody);
  expect(reject.api.body).toBe(PACKAGE_ACCESS_REQUEST_SCHEMAS.PackageAccessRejectBody);
  for (const spec of [create, approve, reject]) {
    const body = { reason: 'é'.repeat(501), ...(spec === create ? { packageId: PACKAGE } : {}) };
    expect(spec.api.body.safeParse(body).success).toBe(false);
    expect(spec.api.body.safeParse({ ...body, reason: 'é'.repeat(500) }).success).toBe(true);
  }
});
it('requires the project in the request read model', () => {
  expect(packageAccessRequest.safeParse({ ...row, project: null }).success).toBe(false);
});
it.each(['approve', 'reject'])('audits the package name for %s', async (action) => {
  const f = await fixture();
  await f.request(
    `/_pb/package-access-requests/${ID}/${action}`,
    'POST',
    { reason: 'Reviewed' },
    '"r1"',
  );
  const event = f.repository.decide.mock.calls[0]![2].event;
  expect(JSON.parse(event.payloadJson).changes.package.new).toBe('widget');
});

it('explains that the hosted source must be attached first', async () => {
  const f = await fixture();
  f.repository.request.mockRejectedValue(new PackageAccessRequestError('source_not_attached'));
  const response = await f.request('/_pb/projects/demo/package-access-requests', 'POST', {
    packageId: PACKAGE,
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { message: 'The hosted source must be attached to the project first' },
  });
});

it('exports the same reason constraints in components and served operations', () => {
  const document = generateOpenApi(PACKAGE_ACCESS_REQUEST_API_SPECS, {
    title: 'test',
    version: '1',
  });
  const components = document.components.schemas as Record<string, unknown>;
  for (const [path, component] of [
    ['/_pb/projects/{project}/package-access-requests', 'PackageAccessRequestBody'],
    ['/_pb/package-access-requests/{id}/approve', 'PackageAccessApproveBody'],
    ['/_pb/package-access-requests/{id}/reject', 'PackageAccessRejectBody'],
  ] as const) {
    expect(document.paths[path]?.post).toHaveProperty(
      'requestBody.content.application/json.schema',
      components[component],
    );
  }
});
