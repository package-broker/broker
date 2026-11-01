import { describe, expect, it, vi } from 'vitest';
import { setAccessContext } from '../../authz/access-context.js';
import { ACCESS_MUTATION_GUARD_CONSTRAINT, DbError } from '../../db/errors.js';
import { orgContext } from '../../db/port.js';
import type { RequestContext } from '../../plugin.js';
import { REGISTRY_DEFAULTS } from '../registry-config.js';
import {
  createDistTagService,
  createPublishService,
  createUnpublishService,
} from './publish-service.js';
import { manifest } from './render.js';

const { nodeCodecs } = await import(
  new URL('../../../../runtime-node/src/codec/node-codec.ts', import.meta.url).href
);

const NOW = '2026-11-01T12:00:00.000Z';
const PROJECT = '01J0ACME000000000000000001';
const PRINCIPAL = '01J0ACME000000000000000002';
const REQUEST = '01J0ACME000000000000000003';
const PACKAGE = '01J0ACME000000000000000004';

function version(v: string, deprecatedMessage: string | null = null) {
  return {
    id: `01J0ACME0000000000000000${v.replaceAll('.', '').slice(0, 2)}`,
    revision: 1,
    version: v,
    publishedAt: '2026-11-01T11:00:00.000Z',
    metadataJson: JSON.stringify({ name: 'widget', version: v }),
    npmIntegrity: null,
    deprecatedMessage,
  };
}

function harness(projectPermissions: string[], organizationPermissions: string[] = []) {
  const snapshot = {
    packageId: PACKAGE,
    rev: 3,
    createdAt: '2026-11-01T10:00:00.000Z',
    modifiedAt: '2026-11-01T11:00:00.000Z',
    tags: { latest: '1.1.0' } as Record<string, string>,
    versions: [version('1.0.0'), version('1.1.0')],
    inactive: 0,
  };
  const found = {
    token: {
      id: 'token',
      kind: 'svc',
      revoked: false,
      expired: false,
      bindingOk: true,
      scope: { level: 'full', readOnly: false },
    },
    principalStatus: 'active',
    project: { id: PROJECT },
    projectPermissions,
    organizationPermissions,
    validation: null,
  };
  const deps = {
    anchors: async () => [],
    lookupToken: vi.fn(async () => found),
    reads: {
      source: vi.fn(async () => [
        { id: 'source', status: 'active', requirePublishApproval: false },
      ]),
      packageBinding: vi.fn(async () => ({ packageName: null })),
      blobId: async () => 'blob',
    },
    admitted: vi.fn(async () => true),
    writeGuard: () => [],
    writer: { publishVersion: vi.fn() },
    requiredScanners: (): readonly string[] => [],
    scanJobs: { enqueueStatements: async () => ({ statements: [] }) },
    deprecations: { snapshot: vi.fn(async () => snapshot), update: vi.fn(async () => {}) },
    distTags: { update: vi.fn(async () => {}) },
    unpublish: { remove: vi.fn(async () => {}), tarballRemoved: vi.fn(async () => false) },
    blob: {
      stage: vi.fn(async () => {
        throw new Error('unexpected stage');
      }),
      discard: vi.fn(async () => {}),
    },
    codecs: nodeCodecs,
    registry: REGISTRY_DEFAULTS,
    clock: { now: () => new Date(NOW) },
    publicUrl: 'https://broker.test',
  };
  const context = (method: string, path: string, body?: string, params = {}) => {
    const encoded = body === undefined ? undefined : new TextEncoder().encode(body);
    const ctx = {
      request: new Request(`https://broker.test/demo/npm/${path}`, {
        method,
        ...(encoded === undefined
          ? {}
          : {
              body: encoded,
              headers: {
                'content-type': 'application/json',
                'content-length': String(encoded.byteLength),
              },
            }),
      }),
      requestId: REQUEST,
      org: orgContext('org'),
      projectId: PROJECT,
      principal: { kind: 'service', id: PRINCIPAL },
      params: { project: 'demo', ...params },
      ports: {},
    } as unknown as RequestContext;
    setAccessContext(ctx, {
      principal: ctx.principal!,
      projectId: PROJECT,
      boundary: 'project',
      sessionId: null,
      actor: null,
      token: {
        id: 'token',
        kind: 'svc',
        scope: 'full',
        readOnly: false,
        projectMode: 'all',
        projectIds: [],
      },
      rateKey: {
        stage: 'authenticated',
        tokenSelector: 'abcdefghijkl',
        principalId: PRINCIPAL,
        routeClass: 'project',
      },
    });
    return ctx;
  };
  const packument = (deprecated?: string) => ({
    _id: 'widget',
    _rev: '3',
    name: 'widget',
    'dist-tags': snapshot.tags,
    versions: Object.fromEntries(
      snapshot.versions.map((v) => {
        const doc = manifest(
          { publicUrl: 'https://broker.test', projectSlug: 'demo' },
          v,
          'widget',
        );
        return [
          v.version,
          v.version === '1.0.0' && deprecated !== undefined ? { ...doc, deprecated } : doc,
        ];
      }),
    ),
    time: {
      created: snapshot.createdAt,
      modified: snapshot.modifiedAt,
      ...Object.fromEntries(snapshot.versions.map((v) => [v.version, v.publishedAt])),
    },
  });
  return { deps, found, snapshot, context, packument };
}

const MANAGE = ['project:read', 'project:packages:read', 'project:packages:manage'];
const json = async (response: Response) => (await response.json()) as { code?: string };

describe('shared manifest route', () => {
  it('refuses _attachments from a manage-only caller before opening staging', async () => {
    const h = harness(MANAGE);
    const body = JSON.stringify({
      name: 'widget',
      versions: { '2.0.0': { name: 'widget', version: '2.0.0' } },
      _attachments: { 'widget-2.0.0.tgz': { data: 'A'.repeat(4096), length: 3072 } },
    });
    const response = await createPublishService(h.deps as never)(
      h.context('PUT', 'widget', body),
      'widget',
    );
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ code: 'forbidden' });
    expect(h.deps.blob.stage).not.toHaveBeenCalled();
    expect(h.deps.writer.publishVersion).not.toHaveBeenCalled();
  });

  it('deprecates for a manage-only caller without staging', async () => {
    const h = harness(MANAGE);
    const response = await createPublishService(h.deps as never)(
      h.context('PUT', 'widget', JSON.stringify(h.packument('old'))),
      'widget',
    );
    expect(response.status).toBe(200);
    expect(h.deps.blob.stage).not.toHaveBeenCalled();
    expect(h.deps.deprecations.update).toHaveBeenCalledOnce();
  });

  it('maps a lost deprecation guard to the same 409 conflict as tags and unpublish', async () => {
    const h = harness(MANAGE);
    h.deps.deprecations.update.mockRejectedValue(
      new DbError('unique', 'guard', { constraint: ACCESS_MUTATION_GUARD_CONSTRAINT }),
    );
    const response = await createPublishService(h.deps as never)(
      h.context('PUT', 'widget', JSON.stringify(h.packument('old'))),
      'widget',
    );
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ code: 'conflict' });
  });

  it('refuses an over-long deprecation message with its own fixed message', async () => {
    const h = harness(MANAGE);
    const response = await createPublishService(h.deps as never)(
      h.context('PUT', 'widget', JSON.stringify(h.packument('x'.repeat(1025)))),
      'widget',
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      code: 'deprecation_too_long',
      error: 'Deprecation message is too long',
    });
    expect(h.deps.deprecations.update).not.toHaveBeenCalled();
  });

  it('accepts a deprecation message at the limit', async () => {
    const h = harness(MANAGE);
    const response = await createPublishService(h.deps as never)(
      h.context('PUT', 'widget', JSON.stringify(h.packument('x'.repeat(1024)))),
      'widget',
    );
    expect(response.status).toBe(200);
  });
});

describe('dist-tag removal', () => {
  it('refuses removing a tag that does not exist before writing', async () => {
    const h = harness(MANAGE);
    const response = await createDistTagService(h.deps as never)(
      h.context('DELETE', '-/package/widget/dist-tags/beta'),
      'widget',
      'beta',
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ code: 'invalid_dist_tag' });
    expect(h.deps.distTags.update).not.toHaveBeenCalled();
  });

  it('removes an existing tag', async () => {
    const h = harness(MANAGE);
    h.snapshot.tags = { latest: '1.1.0', beta: '1.0.0' };
    const response = await createDistTagService(h.deps as never)(
      h.context('DELETE', '-/package/widget/dist-tags/beta'),
      'widget',
      'beta',
    );
    expect(response.status).toBe(200);
    expect(h.deps.distTags.update).toHaveBeenCalledOnce();
  });
});

describe('unpublish', () => {
  it('answers a fixed message when a version that is not active blocks whole-package removal', async () => {
    const h = harness(MANAGE);
    h.snapshot.inactive = 1;
    const response = await createUnpublishService(h.deps as never)(
      h.context('DELETE', 'widget/-rev/3'),
      'widget',
      '3',
    );
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({
      code: 'unpublish_blocked',
      error: 'A version that is not active blocks removal of the whole package',
    });
    expect(h.deps.unpublish.remove).not.toHaveBeenCalled();
  });

  it('removes the whole package when every version is active', async () => {
    const h = harness(MANAGE);
    const response = await createUnpublishService(h.deps as never)(
      h.context('DELETE', 'widget/-rev/3'),
      'widget',
      '3',
    );
    expect(response.status).toBe(200);
    expect(h.deps.unpublish.remove).toHaveBeenCalledOnce();
  });

  it('requires the revision on tarball removal', async () => {
    const h = harness(MANAGE);
    const response = await createUnpublishService(h.deps as never)(
      h.context('DELETE', 'widget/-/widget-1.0.0.tgz'),
      'widget',
      '',
      'widget-1.0.0.tgz',
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ code: 'invalid_unpublish' });
    expect(h.deps.unpublish.remove).not.toHaveBeenCalled();
    expect(h.deps.unpublish.tarballRemoved).not.toHaveBeenCalled();
  });
});
