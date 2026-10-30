import { describe, expect, it } from 'vitest';
import { publishRoutes } from './publishes.js';
import { generateOpenApi } from '../openapi.js';
import { publishSpecs } from './publishes-schemas.js';

describe('publish approval routes', () => {
  it('declares scoped reads and session-only, conditional decisions', () => {
    const routes = publishRoutes({} as never);
    expect(routes.map((r) => [r.method, r.path, r.permission, r.boundary])).toEqual([
      ['GET', '/_pb/publishes', 'org:packages:read', 'organization'],
      ['GET', '/_pb/publishes/:id', 'org:packages:read', 'organization'],
      ['POST', '/_pb/publishes/:id/approve', 'org:packages:approve', 'organization'],
      ['POST', '/_pb/publishes/:id/reject', 'org:packages:approve', 'organization'],
    ]);
    const doc = generateOpenApi(publishSpecs, { title: 'test', version: 'test' });
    expect(doc.paths['/_pb/publishes/{id}/approve']).toBeDefined();
    expect(
      publishSpecs
        .filter((s) => s.method === 'POST')
        .every((s) => 'concurrency' in s && s.concurrency === 'if-match'),
    ).toBe(true);
  });
});

import { vi } from 'vitest';
import { setAccessContext } from '../../authz/access-context.js';
import { orgContext } from '../../db/port.js';
import { fixedClock, ulid } from '../../ids.js';
import type { RequestContext } from '../../plugin.js';
import type { PublishInspection } from '../../db/publishes.js';

function fixture(self = false) {
  const id = ulid(),
    actorId = ulid();
  const item = {
    id,
    revision: 3,
    requestedByType: 'user',
    requestedById: self ? actorId : ulid(),
    tokenId: ulid(),
    packageName: 'widget',
    version: '1.0.0',
    approvalState: 'pending',
    scanState: 'not_required',
  } as PublishInspection;
  const get = vi.fn(async () => item);
  const decide = vi.fn(async () => ({ changed: true, active: true, revision: 4 }));
  const list = vi.fn(async () => ({ items: [], next: null }));
  const routes = publishRoutes({
    publishes: { get, decide, list },
    ids: { ulid },
    clock: fixedClock('2026-10-30T00:00:00.000Z'),
    clientIp: () => null,
  });
  function context(method: string, path: string, body?: unknown, match: string | null = '"r3"') {
    const ctx: RequestContext = {
      request: new Request('https://broker.test' + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(match === null ? {} : { 'if-match': match }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      requestId: ulid(),
      org: orgContext('org'),
      principal: { kind: 'user', id: actorId },
      projectId: null,
      params: { id },
      ports: {} as never,
    };
    setAccessContext(ctx, {
      principal: ctx.principal,
      projectId: null,
      boundary: 'organization',
      sessionId: 'session',
      token: null,
      actor: {
        session: { id: 'session', userId: actorId },
        user: { id: actorId },
        organizationPermissions: ['org:packages:approve'],
        projectPermissions: [],
        protectedHolder: false,
      },
      rateKey: {
        stage: 'authenticated',
        tokenSelector: null,
        principalId: actorId,
        routeClass: 'organization',
      },
    });
    return ctx;
  }
  return { id, item, routes, context, get, decide, list };
}

describe('publish approval handler guards', () => {
  it('returns the inspection ETag and defaults to fifty rows', async () => {
    const f = fixture();
    const response = await f.routes[1]!.handler(f.context('GET', `/_pb/publishes/${f.id}`));
    expect(response.headers.get('etag')).toBe('"r3"');
    expect(response.status).toBe(200);
    expect((await f.routes[0]!.handler(f.context('GET', '/_pb/publishes'))).status).toBe(200);
    expect(f.list).toHaveBeenCalledWith(orgContext('org'), { limit: 50 });
  });
  it('rejects self approval before a write', async () => {
    const f = fixture(true);
    expect(
      (await f.routes[2]!.handler(f.context('POST', `/_pb/publishes/${f.id}/approve`, {}))).status,
    ).toBe(403);
    expect(f.decide).not.toHaveBeenCalled();
  });
  it.each([null, 'invalid'])('requires a valid If-Match before a write (%s)', async (match) => {
    const f = fixture();
    expect(
      (await f.routes[2]!.handler(f.context('POST', `/_pb/publishes/${f.id}/approve`, {}, match)))
        .status,
    ).toBe(match === null ? 428 : 400);
    expect(f.decide).not.toHaveBeenCalled();
  });
  it('maps a lost compare-and-set to 412', async () => {
    const f = fixture();
    f.decide.mockResolvedValue({ changed: false, active: false, revision: 4 });
    expect(
      (await f.routes[2]!.handler(f.context('POST', `/_pb/publishes/${f.id}/approve`, {}))).status,
    ).toBe(412);
  });
  it.each([
    '',
    '   ',
    'é'.repeat(501),
    'https://user:password@example.test/archive',
    'person@example.test',
  ])('refuses unsafe or unbounded rejection input %#', async (reason) => {
    const f = fixture();
    expect(
      (await f.routes[3]!.handler(f.context('POST', `/_pb/publishes/${f.id}/reject`, { reason })))
        .status,
    ).toBe(400);
    expect(f.decide).not.toHaveBeenCalled();
  });
  it('accepts a 1000-byte reason and prepares its audit before writing', async () => {
    const f = fixture();
    const reason = 'Policy refusal. '.repeat(62) + 'Refused.';
    expect(new TextEncoder().encode(reason).length).toBe(1000);
    expect(
      (await f.routes[3]!.handler(f.context('POST', `/_pb/publishes/${f.id}/reject`, { reason })))
        .status,
    ).toBe(200);
    const input = f.decide.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { event: { payloadJson: string }; reason: string },
    ];
    expect(input[2].reason).toBe(reason);
    expect(JSON.parse(input[2].event.payloadJson).changes.reason.new).toBe(reason);
  });
});

it('permits an approver to reject their own publish', async () => {
  const f = fixture(true);
  expect(
    (
      await f.routes[3]!.handler(
        f.context('POST', `/_pb/publishes/${f.id}/reject`, { reason: 'Rejected by requester' }),
      )
    ).status,
  ).toBe(200);
  expect(f.decide).toHaveBeenCalledTimes(1);
});

it('accepts an empty optional approval reason', async () => {
  const f = fixture();
  expect(
    (
      await f.routes[2]!.handler(
        f.context('POST', `/_pb/publishes/${f.id}/approve`, { reason: '' }),
      )
    ).status,
  ).toBe(200);
});

it.each(['approved', 'rejected', 'expired'] as const)(
  'returns already_decided for %s',
  async (state) => {
    const f = fixture();
    f.get.mockResolvedValue({ ...f.item, approvalState: state });
    const response = await f.routes[2]!.handler(
      f.context('POST', `/_pb/publishes/${f.id}/approve`, {}),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'already_decided' } });
    expect(f.decide).not.toHaveBeenCalled();
  },
);
it.each([2, 3])('prepares package and version audit fields for route %s', async (route) => {
  const f = fixture();
  await f.routes[route]!.handler(
    f.context('POST', `/_pb/publishes/${f.id}/${route === 2 ? 'approve' : 'reject'}`, {
      reason: 'Policy',
    }),
  );
  const input = f.decide.mock.calls[0] as unknown as [
    unknown,
    unknown,
    { event: { payloadJson: string } },
  ];
  expect(JSON.parse(input[2].event.payloadJson).changes).toMatchObject({
    package: { new: 'widget' },
    version: { new: '1.0.0' },
  });
});
it('omits orphaned decision body components', async () => {
  const schemas = await import('./publishes-schemas.js');
  expect(schemas.PUBLISH_SCHEMAS).not.toHaveProperty('PublishApproveBody');
  expect(schemas.PUBLISH_SCHEMAS).not.toHaveProperty('PublishRejectBody');
});

it('returns already_decided when a concurrent decision wins', async () => {
  const f = fixture();
  f.get.mockResolvedValueOnce(f.item).mockResolvedValue({ ...f.item, approvalState: 'approved' });
  f.decide.mockResolvedValue({ changed: false, active: false, revision: 4 });
  const response = await f.routes[2]!.handler(
    f.context('POST', `/_pb/publishes/${f.id}/approve`, {}),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'already_decided' } });
});
