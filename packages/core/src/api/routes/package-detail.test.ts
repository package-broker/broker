import { expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../auth/cookies.js';
import { sha256Hex } from '../../auth/primitives.js';
import { createAuthorizationEngine, patValidationGate } from '../../authz/engine.js';
import type { PackageDetailRepository } from '../../db/package-admin.js';
import type { IdempotencyRecord } from '../idempotency.js';
import { orgContext } from '../../db/port.js';
import { fixedClock } from '../../ids.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { packageDetailRoutes } from './package-detail.js';
const ORIGIN = 'https://broker.test';
const ID = '01JA0000000000000000000001';
const PACKAGE = '01JA0000000000000000000002';
const USER = '01JA0000000000000000000003';
const SECRET = 'A'.repeat(43),
  CSRF = 'B'.repeat(43);
const now = '2026-10-30T00:00:00.000Z';
async function fixture(
  permissions = ['project:read', 'project:packages:read', 'org:sources:write'],
) {
  const repository = {
    packageName: vi.fn<PackageDetailRepository['packageName']>().mockResolvedValue('widget'),
    readme: vi
      .fn<PackageDetailRepository['readme']>()
      .mockResolvedValue({ filename: 'README.md', body: '# Widget' }),
    setAccess: vi.fn<PackageDetailRepository['setAccess']>().mockResolvedValue({ ok: true }),
  };
  const find = vi.fn<() => Promise<IdempotencyRecord | null>>().mockResolvedValue(null);
  const clock = fixedClock(now),
    ids = { ulid: () => ID },
    log = vi.fn();
  const routes = packageDetailRoutes({
    repository,
    clock,
    ids,
    clientIp: () => null,
    idempotency: { find },
  });
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: routes,
    packageResolver: {
      resolve: async (_actor, _ecosystem, name) =>
        name === 'widget'
          ? {
              kind: 'visible' as const,
              cacheKey: () => {
                throw new Error('unexpected cache use');
              },
              epochReader: { read: async () => null },
              pkg: {
                packageId: PACKAGE,
                projectId: ID,
                ecosystem: 'npm' as const,
                key: 'widget',
                sourceId: ID,
                rev: 1,
                modifiedAt: now,
                createdAt: now,
                listingComplete: true,
                cacheEpoch: null,
              },
            }
          : { kind: 'absent' as const },
    },
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
  const request = (path: string, method = 'GET', body?: unknown, key?: string) =>
    kernel.fetch(
      new Request(ORIGIN + path, {
        method,
        headers: {
          origin: ORIGIN,
          cookie: `${SESSION_COOKIE}=${SECRET}`,
          'x-csrf-token': CSRF,
          'content-type': 'application/json',
          ...(key === undefined ? {} : { 'idempotency-key': key }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { request, repository, routes, log, find };
}

const readmePath = `/_pb/projects/demo/packages/${PACKAGE}/readme`;
const accessPath = `/_pb/packages/${PACKAGE}/access`;
const access = { visibleToNewProjects: false, newProjectAccessMode: 'request', revision: 1 };
it('resolves package ids through the package boundary and reads an explicit README', async () => {
  const f = await fixture();
  const response = await f.request(readmePath + '?version=1.0.0');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    filename: 'README.md',
    body: '# Widget',
    contentType: 'text/markdown',
    sizeBytes: 8,
  });
  expect(f.repository.packageName).toHaveBeenCalledWith(orgContext('org-1'), PACKAGE);
  expect(f.repository.readme).toHaveBeenCalledWith(orgContext('org-1'), {
    packageId: PACKAGE,
    projectId: ID,
    version: '1.0.0',
  });
});
it('returns matching 404s for invisible and missing readmes', async () => {
  const f = await fixture();
  f.repository.packageName.mockResolvedValue(null);
  expect((await f.request(readmePath)).status).toBe(404);
  expect(f.repository.readme).not.toHaveBeenCalled();
  f.repository.packageName.mockResolvedValue('widget');
  f.repository.readme.mockResolvedValue(null);
  expect((await f.request(readmePath)).status).toBe(404);
});
it('requires project package read permission before looking up content', async () => {
  const f = await fixture(['project:read']);
  expect((await f.request(readmePath)).status).toBe(403);
  expect(f.repository.packageName).not.toHaveBeenCalled();
  expect(f.repository.readme).not.toHaveBeenCalled();
});
it('enforces the byte cap and rejects duplicate version queries', async () => {
  const f = await fixture();
  f.repository.readme.mockResolvedValue({ filename: 'README.md', body: 'é'.repeat(262145) });
  expect((await f.request(readmePath)).status).toBe(404);
  expect((await f.request(readmePath + '?version=one&version=two')).status).toBe(400);
});
it('updates access with a prepared audit and body revision', async () => {
  const f = await fixture();
  const response = await f.request(accessPath, 'PATCH', access, 'retry');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...access, revision: 2 });
  expect(f.repository.setAccess).toHaveBeenCalledWith(
    orgContext('org-1'),
    expect.objectContaining({ userId: USER }),
    expect.objectContaining({
      ...access,
      packageId: PACKAGE,
      audit: expect.objectContaining({ action: 'package.access_update' }),
      idempotency: expect.objectContaining({ key: 'retry' }),
    }),
  );
});
it('rejects request mode with automatic visibility and invalid revisions before writing', async () => {
  const f = await fixture();
  for (const body of [
    { ...access, visibleToNewProjects: true },
    { ...access, revision: 0 },
    { ...access, revision: 1.5 },
  ]) {
    expect((await f.request(accessPath, 'PATCH', body)).status).toBe(400);
  }
  expect(f.repository.setAccess).not.toHaveBeenCalled();
});
it('returns the repository owner authority refusal', async () => {
  const f = await fixture(['org:sources:read']);
  f.repository.setAccess.mockResolvedValue({ ok: false, error: 'forbidden' });
  expect((await f.request(accessPath, 'PATCH', access)).status).toBe(403);
  expect(f.repository.setAccess).toHaveBeenCalled();
});
it('reports stale revisions and validates idempotency headers', async () => {
  const f = await fixture();
  f.repository.setAccess.mockResolvedValue({ ok: false, error: 'conflict' });
  expect((await f.request(accessPath, 'PATCH', access)).status).toBe(409);
  expect((await f.request(accessPath, 'PATCH', access, 'invalid key')).status).toBe(400);
});
it('replays committed results and rejects a reused key with different input', async () => {
  const f = await fixture();
  await f.request(accessPath, 'PATCH', access, 'retry');
  const input = f.repository.setAccess.mock.calls[0]![2];
  f.find.mockResolvedValue(input.idempotency!);
  f.repository.setAccess.mockClear();
  expect((await f.request(accessPath, 'PATCH', access, 'retry')).status).toBe(200);
  expect((await f.request(accessPath, 'PATCH', { ...access, revision: 2 }, 'retry')).status).toBe(
    409,
  );
  expect(f.repository.setAccess).not.toHaveBeenCalled();
});
