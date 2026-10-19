import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../auth/cookies.js';
import * as catalogueModule from '../authz/catalogue.js';
import * as packageActorModule from '../internal/package-actor.js';
import { accessContextOf } from '../authz/access-context.js';
import { createAuthorizationEngine, patValidationGate } from '../authz/engine.js';
import type { EngineSessionAccess, EngineTokenAccess } from '../authz/engine.js';
import { createPackageAccess } from '../catalogue/package-access.js';
import type { CatalogueReader, PackageVisibility, PackageVisibilityPort } from '../db/catalogue.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import type { PluginDefinition, PluginPorts, RequestContext } from '../plugin.js';
import { createKeyring } from '../secrets/keyring.js';
import { formatToken } from '../secrets/token-format.js';
import { hashToken } from '../secrets/token-hash.js';
import type { AuthorizationEngine } from './authorize.js';
import { createKernel } from './kernel.js';
import { resolvedPackageOf } from './package-context.js';
import { setResolvedPackage } from '../internal/package-context.js';

const org = orgContext('org-1');
const read = 'project:packages:read';
const write = 'project:packages:write';
const permissions = [read, write, 'project:settings:write', 'project:grants:write'];
const cookie = { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` };
const admission: PackageVisibility = {
  kind: 'proxy_admissible',
  projectId: 'proj-1',
  ecosystem: 'composer',
  key: 'acme/lib',
  sourceIds: ['source-1'],
};
const visible: Extract<PackageVisibility, { kind: 'visible' }> = {
  kind: 'visible',
  pkg: {
    projectId: 'proj-1',
    ecosystem: 'composer',
    key: 'acme/lib',
    packageId: 'pkg-1',
    sourceId: 'source-1',
    rev: 1,
    modifiedAt: '2026-10-16',
    createdAt: '2026-10-16',
    listingComplete: true,
    cacheEpoch: null,
  },
  cacheKey: () => {
    throw new Error('unused');
  },
  epochReader: { read: async () => null },
};
const ports: PluginPorts = {
  organizations: { get: async () => null },
  clock: fixedClock('2026-10-16T00:00:00Z'),
  ids: { ulid: () => '01JA0000000000000000000000' },
};
interface Options {
  outcome?: PackageVisibility;
  resolve?: PackageVisibilityPort['resolve'];
  name?: () => string | null;
  fetchOnAdmission?: boolean;
  permission?: string;
  allowed?: readonly string[];
  credential?: 'session' | 'pat' | 'svc' | 'none';
  denyHook?: boolean;
  authorization?: AuthorizationEngine;
  handler?: (ctx: RequestContext) => Response;
}
async function harness(options: Options = {}) {
  const credential = options.credential ?? 'session';
  const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
  const token = formatToken(
    credential === 'svc' ? 'svc' : 'pat',
    'abcdefghijkl',
    new Uint8Array(32).fill(9),
  );
  const session: EngineSessionAccess = {
    session: { id: 'session-1', csrfHash: '' },
    user: { id: 'user-1' },
    identity: null,
    protectedHolder: false,
    project: { id: 'proj-1' },
    organizationPermissions: [],
    projectPermissions: options.allowed ?? permissions,
  };
  const tokenAccess = Object.defineProperty(
    {
      token: {
        id: 'token-1',
        kind: credential === 'svc' ? 'svc' : 'pat',
        expired: false,
        revoked: false,
        lastUsedAt: null,
        userId: credential === 'svc' ? null : 'user-1',
        servicePrincipalId: credential === 'svc' ? 'svc-1' : null,
      },
      principalStatus: 'active',
      validation:
        credential === 'svc'
          ? null
          : { kind: 'local', identityId: null, fresh: true, evidenceAt: null },
      project: session.project,
      organizationPermissions: [],
      projectPermissions: session.projectPermissions,
    },
    'verifier',
    { value: { secretHash: await hashToken(keyring, 1, token), pepperVersion: 1 } },
  ) as unknown as EngineTokenAccess;
  const authorization =
    options.authorization ??
    createAuthorizationEngine({
      access: {
        lookupSession: async (_ctx, input) => ({
          ...session,
          project:
            input.projectSlug === 'foreign'
              ? { id: 'proj-foreign' }
              : input.projectSlug === 'demo'
                ? session.project
                : null,
          projectPermissions: input.projectSlug === 'foreign' ? [] : session.projectPermissions,
        }),
        lookupToken: async (_ctx, input) =>
          Object.defineProperty(
            { ...tokenAccess, project: input.projectSlug === 'demo' ? tokenAccess.project : null },
            'verifier',
            Object.getOwnPropertyDescriptor(tokenAccess, 'verifier')!,
          ),
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: { keyring, nowMs: () => 0, dispatch: () => undefined, log: () => undefined },
      patValidation: patValidationGate,
      publicOrigin: 'https://broker.test',
      providerAnchors: async () => [],
    });
  const resolve = vi.fn<PackageVisibilityPort['resolve']>(
    options.resolve ?? (async () => options.outcome ?? { kind: 'absent' as const }),
  );
  const handler = vi.fn(options.handler ?? (() => new Response('ok')));
  const extractor = vi.fn(options.name ?? (() => 'acme/lib'));
  const plugin: PluginDefinition = {
    id: 'package-test',
    package: '@test/package-test',
    apiVersion: 3,
    platforms: ['node'],
    register(registry) {
      registry.route({
        method: 'GET',
        path: '/p/:project/pkg/:name',
        boundary: 'package',
        permission: options.permission ?? read,
        package: {
          ecosystem: 'composer',
          name: extractor,
          fetchOnAdmission: options.fetchOnAdmission ?? false,
        },
        handler,
      });
      if (options.denyHook)
        registry.hook('access.check', () => ({ deny: true, reason: 'refused' }));
    },
  };
  const logs: unknown[] = [];
  const kernel = await createKernel({
    platform: 'node',
    plugins: [plugin],
    ports,
    authorization,
    packageResolver: { resolve },
    resolveOrg: async () => org,
    health: async () => true,
    log: (entry) => {
      logs.push(entry);
    },
  });
  const headers =
    credential === 'none'
      ? {}
      : credential === 'session'
        ? cookie
        : { authorization: `Bearer ${token}` };
  return {
    resolve,
    handler,
    extractor,
    logs,
    fetch: (project = 'demo', method = 'GET') =>
      kernel.fetch(
        new Request(`https://broker.test/p/${project}/pkg/acme-lib`, { method, headers }),
      ),
  };
}
async function bytes(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers].filter(([key]) => key !== 'x-request-id'),
    body: [...new Uint8Array(await response.arrayBuffer())],
  };
}

describe('package boundary resolution', () => {
  it.each([
    'absent',
    'invisible',
    'null',
    'empty',
    'unparseable',
    'foreign',
    'archived',
    'admission',
  ] as const)('uniform 404 for %s and HEAD', async (kind) => {
    const requestId = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000000');
    try {
      const resolveVersions = vi.fn(async () => null);
      const admitProxy = vi.fn(async () => []);
      const reader = new Proxy(
        {},
        {
          get: (_target, property) =>
            kind === 'invisible' && property === 'resolveVersions'
              ? resolveVersions
              : kind === 'invisible' && property === 'admitProxy'
                ? admitProxy
                : vi.fn(() => {
                    throw new Error('reader must not run');
                  }),
        },
      ) as CatalogueReader;
      const h = await harness({
        ...(kind === 'null' ? { name: () => null } : {}),
        ...(kind === 'empty' ? { name: () => '' } : {}),
        ...(kind === 'unparseable'
          ? { name: () => '../bad', resolve: createPackageAccess(reader).resolve }
          : {}),
        ...(kind === 'invisible' ? { resolve: createPackageAccess(reader).resolve } : {}),
        ...(kind === 'admission' ? { outcome: admission } : {}),
      });
      const baseline = await bytes(await h.fetch('unknown'));
      const headBaseline = await bytes(await h.fetch('unknown', 'HEAD'));
      expect(h.resolve).not.toHaveBeenCalled();
      expect(h.handler).not.toHaveBeenCalled();
      const project = kind === 'foreign' || kind === 'archived' ? kind : 'demo';
      expect(await bytes(await h.fetch(project))).toEqual(baseline);
      expect(await bytes(await h.fetch(project, 'HEAD'))).toEqual(headBaseline);
      expect(headBaseline.status).toBe(404);
      expect(headBaseline.body).toEqual([]);
      expect(h.handler).not.toHaveBeenCalled();
      expect(h.resolve).toHaveBeenCalledTimes(
        ['null', 'empty', 'foreign', 'archived'].includes(kind) ? 0 : 2,
      );
      if (kind === 'invisible') {
        expect(resolveVersions).toHaveBeenCalledTimes(2);
        expect(admitProxy).toHaveBeenCalledTimes(2);
        expect(resolveVersions).toHaveBeenCalledWith(org, {
          projectId: 'proj-1',
          ecosystem: 'composer',
          key: 'acme/lib',
          limit: 1,
        });
      }
    } finally {
      requestId.mockRestore();
    }
  });
  it('passes an admission only to a fetchOnAdmission handler', async () => {
    const h = await harness({ outcome: admission, fetchOnAdmission: true });
    expect((await h.fetch()).status).toBe(200);
    expect(resolvedPackageOf(h.handler.mock.calls[0]![0])).toEqual(admission);
    expect(h.resolve).toHaveBeenCalledTimes(1);
  });
  it('does not fetch a proxy admission on HEAD', async () => {
    const h = await harness({ outcome: admission, fetchOnAdmission: true });
    const head = await h.fetch('demo', 'HEAD');
    expect(head.status).toBe(404);
    expect(await head.text()).toBe('');
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.handler).not.toHaveBeenCalled();
  });
  it.each(['visible', 'proxy_admissible'] as const)(
    'copies and freezes the %s handler outcome',
    async (kind) => {
      const outcome =
        kind === 'visible'
          ? { ...visible, pkg: { ...visible.pkg } }
          : { ...admission, sourceIds: ['source-1'] };
      const h = await harness({ outcome, fetchOnAdmission: true });
      expect((await h.fetch()).status).toBe(200);
      const stored = resolvedPackageOf(h.handler.mock.calls[0]![0])!;
      expect(stored).toEqual(outcome);
      expect(stored).not.toBe(outcome);
      expect(Object.isFrozen(stored)).toBe(true);
      if (stored.kind === 'visible' && 'pkg' in outcome) {
        outcome.pkg.key = 'other/pkg';
        expect(stored.pkg.key).toBe('acme/lib');
        expect(Object.isFrozen(stored.pkg)).toBe(true);
      } else if (stored.kind === 'proxy_admissible' && 'sourceIds' in outcome) {
        outcome.sourceIds.push('other-source');
        expect(stored.sourceIds).toEqual(['source-1']);
        expect(Object.isFrozen(stored.sourceIds)).toBe(true);
      }
    },
  );
  it('compares the requested name using its canonical package key', async () => {
    const h = await harness({ name: () => 'ACME/Lib', outcome: visible });
    expect((await h.fetch()).status).toBe(200);
  });
  it('exposes visible packages with a project snapshot and unchanged context keys', async () => {
    const h = await harness({ outcome: visible });
    expect((await h.fetch()).status).toBe(200);
    const ctx = h.handler.mock.calls[0]![0];
    expect(resolvedPackageOf(ctx)).toEqual(visible);
    expect(accessContextOf(ctx)?.boundary).toBe('project');
    expect(Object.keys(ctx).sort()).toEqual(
      ['request', 'requestId', 'org', 'principal', 'projectId', 'params', 'ports'].sort(),
    );
    expect(() => setResolvedPackage(ctx, visible)).toThrow();
    expect(resolvedPackageOf({} as RequestContext)).toBeNull();
  });
  it.each(['session', 'pat', 'svc'] as const)(
    'passes the clipped %s actor to the port',
    async (credential) => {
      const h = await harness({ credential, outcome: visible });
      expect((await h.fetch()).status).toBe(200);
      expect(h.resolve).toHaveBeenCalledWith(
        {
          kind: 'project',
          projectId: 'proj-1',
          orgId: org.orgId,
          userId: credential === 'svc' ? 'svc-1' : 'user-1',
          permissions: expect.objectContaining({ has: expect.any(Function) }),
        },
        'composer',
        'acme/lib',
      );
      expect([...h.resolve.mock.calls[0]![0].permissions]).toEqual([read, write]);
    },
  );
  it.each([
    ['unauthenticated', { credential: 'none' }, 401],
    ['missing permission', { allowed: ['project:read'] }, 403],
    ['unknown project', {}, 404],
    ['hook deny', { denyHook: true }, 403],
  ] as const)('never resolves after %s', async (label, options, status) => {
    const h = await harness(options);
    expect((await h.fetch(label === 'unknown project' ? 'unknown' : 'demo')).status).toBe(status);
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.extractor).not.toHaveBeenCalled();
    expect(h.handler).not.toHaveBeenCalled();
  });
  it('never resolves when a token permission is sessionOnly', async () => {
    const eligibility = vi.spyOn(catalogueModule, 'catalogueTokenEligible').mockReturnValue(false);
    try {
      const h = await harness({ credential: 'pat' });
      expect((await h.fetch()).status).toBe(403);
      expect(h.resolve).not.toHaveBeenCalled();
      expect(h.handler).not.toHaveBeenCalled();
    } finally {
      eligibility.mockRestore();
    }
  });
  it('refuses a write-only holder through PackageAccess', async () => {
    const reader = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('reader must not run');
        },
      },
    ) as CatalogueReader;
    const h = await harness({
      allowed: [write],
      permission: write,
      resolve: createPackageAccess(reader).resolve,
    });
    expect((await h.fetch()).status).toBe(404);
    expect(h.handler).not.toHaveBeenCalled();
  });
  it.each([
    'throws',
    'rejects',
    'extractor',
    'kind',
    'project',
    'ecosystem',
    'key',
    'admission-project',
    'admission-ecosystem',
    'admission-key',
    'sources',
  ] as const)('returns fixed 500 for %s', async (kind) => {
    const bad = {
      ...admission,
      ...(kind === 'sources' ? { sourceIds: [] } : {}),
      ...(kind === 'admission-project' ? { projectId: 'other' } : {}),
      ...(kind === 'admission-ecosystem' ? { ecosystem: 'npm' } : {}),
      ...(kind === 'admission-key' ? { key: 'other/pkg' } : {}),
    };
    const h = await harness({
      fetchOnAdmission: true,
      ...(kind === 'throws'
        ? {
            resolve: () => {
              throw new Error('private detail');
            },
          }
        : {}),
      ...(kind === 'rejects' ? { resolve: () => Promise.reject(new Error('private detail')) } : {}),
      ...(kind === 'extractor'
        ? {
            name: () => {
              throw new Error('private detail');
            },
          }
        : {}),
      ...([
        'kind',
        'project',
        'ecosystem',
        'key',
        'admission-project',
        'admission-ecosystem',
        'admission-key',
        'sources',
      ].includes(kind)
        ? {
            outcome: (kind === 'kind'
              ? { kind: 'unknown' }
              : kind === 'project' || kind === 'ecosystem' || kind === 'key'
                ? {
                    ...visible,
                    pkg: {
                      ...visible.pkg,
                      ...(kind === 'project'
                        ? { projectId: 'other' }
                        : kind === 'key'
                          ? { key: 'other/pkg' }
                          : { ecosystem: 'npm' }),
                    },
                  }
                : bad) as PackageVisibility,
          }
        : {}),
    });
    const response = await h.fetch();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: 'internal', message: 'Internal error' },
    });
    expect(JSON.stringify(h.logs)).not.toContain('private detail');
    expect(h.handler).not.toHaveBeenCalled();
    if (kind === 'extractor') expect(h.resolve).not.toHaveBeenCalled();
  });
  it.each([
    'missing grant',
    'missing actor',
    'user mismatch',
    'project mismatch',
    'org mismatch',
  ] as const)('fails closed for %s', async (kind) => {
    const actor = {
      kind: 'project' as const,
      userId: 'user-1',
      orgId: org.orgId,
      projectId: 'proj-1',
      permissions: new Set([read]),
    };
    const actorSpy =
      kind === 'missing grant'
        ? null
        : vi.spyOn(packageActorModule, 'packageActorOf').mockReturnValue(
            kind === 'missing actor'
              ? null
              : {
                  ...actor,
                  ...(kind === 'user mismatch'
                    ? { userId: 'other' }
                    : kind === 'project mismatch'
                      ? { projectId: 'other' }
                      : { orgId: orgContext('other').orgId }),
                },
          );
    try {
      const h = await harness(
        kind === 'missing grant'
          ? {
              authorization: {
                authorize: async () => ({
                  allow: true,
                  principal: { kind: 'user', id: 'user-1' },
                  projectId: 'proj-1',
                }),
              },
            }
          : {},
      );
      expect((await h.fetch()).status).toBe(503);
      expect(h.resolve).not.toHaveBeenCalled();
      expect(h.handler).not.toHaveBeenCalled();
      expect(h.logs).toContainEqual(expect.objectContaining({ event: 'authz.error' }));
    } finally {
      actorSpy?.mockRestore();
    }
  });
});
