import { sha256Hex } from '../../auth/primitives.js';
import { describe, expect, it, vi } from 'vitest';
import { validateAuditEvent } from '../../audit/actions.js';
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
import type { DeprecationStore } from './deprecate.js';

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
    deprecations: {
      snapshot: vi.fn(async () => snapshot),
      update: vi.fn<DeprecationStore['update']>(async () => {}),
    },
    distTags: { update: vi.fn(async () => {}) },
    unpublish: {
      remove: vi.fn<import('./unpublish.js').UnpublishStore['remove']>(async () => {}),
      tarballRemoved: vi.fn(async () => false),
    },
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

it.each(['\n', '\u0000', '\t', '"', '\\', 'é'])(
  'applies and clears escaped deprecation text at the byte limit: %j',
  async (character) => {
    const h = harness(MANAGE);
    const message = character.repeat(1024 / new TextEncoder().encode(character).length);
    h.snapshot.versions[0]!.deprecatedMessage = null;
    const service = createPublishService(h.deps as never);
    for (const next of [message, message.slice(1) + 'x', '']) {
      // Keep the old message at the boundary while testing replacement and clearing.
      const old = h.snapshot.versions[0]!.deprecatedMessage;
      const response = await service(
        h.context('PUT', 'widget', JSON.stringify(h.packument(next))),
        'widget',
      );
      expect(response.status).toBe(200);
      const input = h.deps.deprecations.update.mock.calls.at(-1)![2];
      const payload = JSON.parse(input.edits[0]!.event.payloadJson);
      expect(input.edits[0]!.message).toBe(next);
      expect(input.edits[0]!.old).toBe(old);
      expect(payload.changes.deprecated).toEqual({ old: Boolean(old), new: next !== '' });
      expect(payload.changes.deprecated_sha256).toEqual({
        old: old === null ? null : await sha256Hex(old),
        new: await sha256Hex(next),
      });
      expect(payload.changes).not.toHaveProperty('deprecated_encoding');
      expect(validateAuditEvent(input.edits[0]!.event)).toEqual(input.edits[0]!.event);
      expect(
        new TextEncoder().encode(input.edits[0]!.event.payloadJson).byteLength,
      ).toBeLessThanOrEqual(4096);
      h.snapshot.versions[0]!.deprecatedMessage = next;
    }
    const response = await service(
      h.context('PUT', 'widget', JSON.stringify(h.packument(message + character))),
      'widget',
    );
    expect(response.status).toBe(400);
  },
);
it('unpublishes every version of an 82-version package through the service', async () => {
  const h = harness(MANAGE);
  h.snapshot.versions = Array.from({ length: 82 }, (_, i) => version(`1.0.${i}`));
  const response = await createUnpublishService(h.deps as never)(
    h.context('DELETE', 'widget/-rev/3'),
    'widget',
    '3',
  );
  expect(response.status).toBe(200);
  expect(h.deps.unpublish.remove).toHaveBeenCalledOnce();
  const payload = JSON.parse(h.deps.unpublish.remove.mock.calls[0]![2].event.payloadJson);
  expect(payload.changes).toEqual({ removed_version_count: { new: 82 } });
});
it.each([[MANAGE], [[...MANAGE, 'project:packages:write']]])(
  'answers fixed 405 for a manifest update without a hosted claim',
  async (permissions) => {
    const h = harness(permissions);
    h.deps.reads.source.mockResolvedValue([]);
    const response = await createPublishService(h.deps as never)(
      h.context('PUT', 'widget', JSON.stringify(h.packument('old'))),
      'widget',
    );
    expect(response.status).toBe(405);
    expect(await json(response)).toMatchObject({ code: 'write_unsupported' });
    expect(response.headers.get('Allow')).toBe('GET, HEAD');
    expect(h.deps.blob.stage).not.toHaveBeenCalled();
    expect(h.deps.deprecations.update).not.toHaveBeenCalled();
  },
);

it.each([3, 50])(
  'preserves bounded version lists and the removal count for %i versions',
  async (count) => {
    const h = harness(MANAGE);
    h.snapshot.versions = Array.from({ length: count }, (_, i) => version(`1.0.${i}`));
    const response = await createUnpublishService(h.deps as never)(
      h.context('DELETE', 'widget/-rev/3'),
      'widget',
      '3',
    );
    expect(response.status).toBe(200);
    const payload = JSON.parse(h.deps.unpublish.remove.mock.calls[0]![2].event.payloadJson);
    expect(payload.changes).toEqual({
      removed_version_count: { new: count },
      ...(count <= 50 ? { versions: { old: h.snapshot.versions.map((v) => v.version) } } : {}),
    });
  },
);

it.each([
  ['missing', 411, 'length_required'],
  ['oversize', 413, 'publish_body_too_large'],
  ['malformed', 400, 'invalid_publish_body'],
] as const)(
  'checks %s content-length before looking up an unclaimed name',
  async (kind, status, code) => {
    const h = harness(MANAGE);
    h.deps.reads.source.mockResolvedValue([]);
    const ctx = h.context('PUT', 'widget', JSON.stringify(h.packument('old')));
    if (kind === 'missing') ctx.request.headers.delete('content-length');
    else
      ctx.request.headers.set(
        'content-length',
        kind === 'oversize' ? String(h.deps.registry.caps.publishBodyBytes + 1) : 'invalid',
      );
    const response = await createPublishService(h.deps as never)(ctx, 'widget');
    expect(response.status).toBe(status);
    expect(await json(response)).toMatchObject({ code });
    expect(h.deps.reads.source).not.toHaveBeenCalled();
    expect(ctx.request.bodyUsed).toBe(false);
    expect(h.deps.blob.stage).not.toHaveBeenCalled();
  },
);

it('checks package binding before looking up an unclaimed name', async () => {
  const h = harness(MANAGE);
  h.deps.reads.source.mockResolvedValue([]);
  h.deps.reads.packageBinding.mockResolvedValue(null as never);
  const response = await createPublishService(h.deps as never)(
    h.context('PUT', 'widget', JSON.stringify(h.packument('old'))),
    'widget',
  );
  expect(response.status).toBe(403);
  expect(await json(response)).toMatchObject({ code: 'package_binding' });
  expect(h.deps.reads.source).not.toHaveBeenCalled();
});

it('keeps ambiguous hosted claims as a conflict for manifest updates', async () => {
  const h = harness(MANAGE);
  h.deps.reads.source.mockResolvedValue([
    { id: 'source', status: 'active', requirePublishApproval: false },
    { id: 'other', status: 'active', requirePublishApproval: false },
  ]);
  const response = await createPublishService(h.deps as never)(
    h.context('PUT', 'widget', JSON.stringify(h.packument('old'))),
    'widget',
  );
  expect(response.status).toBe(409);
  expect(await json(response)).toMatchObject({ code: 'name_not_claimed' });
  expect(h.deps.deprecations.update).not.toHaveBeenCalled();
});

it.each(['publish', 'dist-tag', 'unpublish'] as const)(
  'preserves backlog_full through npm %s',
  async (operation) => {
    const h = harness(MANAGE);
    const error = new DbError('backlog_full', 'Audit backlog is full');
    const call =
      operation === 'dist-tag'
        ? (h.deps.distTags.update.mockRejectedValueOnce(error),
          createDistTagService(h.deps as never)(
            h.context('PUT', '-/package/widget/dist-tags/_next', JSON.stringify('1.0.0')),
            'widget',
            '_next',
          ))
        : operation === 'unpublish'
          ? (h.deps.unpublish.remove.mockRejectedValueOnce(error),
            createUnpublishService(h.deps as never)(
              h.context('DELETE', 'widget/-rev/3'),
              'widget',
              '3',
            ))
          : (h.deps.deprecations.update.mockRejectedValueOnce(error),
            createPublishService(h.deps as never)(
              h.context('PUT', 'widget', JSON.stringify(h.packument('retired'))),
              'widget',
            ));
    await expect(call).rejects.toBe(error);
  },
);
it.each(['_next', 'next!'])(
  'sets and removes valid tag %s through audit construction',
  async (tag) => {
    const h = harness(MANAGE);
    expect(
      (
        await createDistTagService(h.deps as never)(
          h.context('PUT', '-/package/widget/dist-tags/' + tag, JSON.stringify('1.0.0')),
          'widget',
          tag,
        )
      ).status,
    ).toBe(200);
    h.snapshot.tags[tag] = '1.0.0';
    expect(
      (
        await createDistTagService(h.deps as never)(
          h.context('DELETE', '-/package/widget/dist-tags/' + tag),
          'widget',
          tag,
        )
      ).status,
    ).toBe(200);
    expect(h.deps.distTags.update).toHaveBeenCalledTimes(2);
  },
);
