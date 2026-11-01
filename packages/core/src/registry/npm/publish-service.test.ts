import { BlobAdmissionError, BlobBusyError, type BlobMetadataPort } from '../../platform/blob.js';
import { setAccessContext, type AccessContextSnapshot } from '../../authz/access-context.js';
import { describe, expect, it, vi } from 'vitest';
import { createPublishService, publishError } from './publish-service.js';
import { API_ERROR_CODES } from '../../api/response.js';
import { orgContext } from '../../db/port.js';
import type { RequestContext } from '../../plugin.js';

const ctx = (name = 'widget') =>
  ({
    request: new Request('https://broker.test/demo/npm/' + name, { method: 'PUT' }),
    requestId: 'request',
    org: orgContext('org'),
    projectId: 'project',
    principal: { kind: 'user', id: 'user' },
    params: { project: 'demo' },
    ports: {},
  }) as unknown as RequestContext;

describe('publish preflight', () => {
  it('refuses a browser session before lookup or reading the body', async () => {
    const lookupToken = vi.fn();
    const publish = createPublishService({ lookupToken } as never);
    const response = await publish(ctx(), 'widget');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'token_required' });
    expect(lookupToken).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toBe('request');
  });
  it('validates lowercase names before credentials', async () => {
    const publish = createPublishService({} as never);
    expect((await publish(ctx(), 'Widget')).status).toBe(400);
  });
});

function authorized(
  tokenOverrides: Partial<NonNullable<AccessContextSnapshot['token']>> = {},
  withBody = true,
) {
  const context = {
    ...ctx(),
    request: new Request('https://broker.test/demo/npm/widget', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'content-length': '2' },
      ...(withBody ? { body: '{}' } : {}),
    }),
  };
  const token = {
    id: 'token',
    kind: 'svc' as const,
    scope: 'write' as const,
    readOnly: false,
    projectMode: 'all' as const,
    projectIds: [],
    ...tokenOverrides,
  };
  setAccessContext(context, {
    principal: context.principal,
    projectId: context.projectId,
    boundary: 'project',
    sessionId: null,
    actor: null,
    token,
    rateKey: {
      stage: 'authenticated',
      tokenSelector: 'abcdefghijkl',
      principalId: 'user',
      routeClass: 'project',
    },
  });
  const found = {
    token: {
      ...token,
      userId: null,
      servicePrincipalId: 'user',
      boundProjectId: null,
      revoked: false,
      expired: false,
      bindingOk: true,
      scope: { level: 'write', readOnly: false },
    },
    principalStatus: 'active',
    project: { id: 'project' },
    projectPermissions: [] as string[],
    organizationPermissions: ['org:packages:publish'],
    validation: null,
  };
  const source = { id: 'source', status: 'active', requirePublishApproval: false };
  const deps = {
    anchors: async () => [],
    lookupToken: vi.fn(async () => found),
    reads: {
      source: vi.fn(async () => [source]),
      packageBinding: vi.fn(async () => ({ packageName: null as string | null })),
    },
    admitted: vi.fn(async () => true),
    requiredScanners: (): readonly string[] => [],
    scanJobs: { enqueueStatements: async () => ({ id: 'job', statements: [] }) },
    blob: {
      stage: vi.fn(async () => {
        throw new Error('unexpected stage');
      }),
    },
  };
  return { context, found, source, deps };
}

describe('publish checks run before the body and staging', () => {
  it.each([
    [
      'unknown token',
      (h: ReturnType<typeof authorized>) => {
        h.deps.lookupToken.mockResolvedValue(null as never);
      },
      403,
      'forbidden',
    ],
    [
      'stale PAT',
      (h: ReturnType<typeof authorized>) => {
        h.found.token.kind = 'pat';
        h.found.validation = { fresh: false } as never;
      },
      403,
      'forbidden',
    ],
    [
      'missing bound token row',
      (h: ReturnType<typeof authorized>) => {
        h.deps.reads.packageBinding.mockResolvedValue(null as never);
      },
      403,
      'package_binding',
    ],
    [
      'revoked token',
      (h: ReturnType<typeof authorized>) => {
        h.found.token.revoked = true;
      },
      403,
      'forbidden',
    ],
    [
      'expired token',
      (h: ReturnType<typeof authorized>) => {
        h.found.token.expired = true;
      },
      403,
      'forbidden',
    ],
    [
      'inactive principal',
      (h: ReturnType<typeof authorized>) => {
        h.found.principalStatus = 'suspended';
      },
      403,
      'forbidden',
    ],
    [
      'invalid binding',
      (h: ReturnType<typeof authorized>) => {
        h.found.token.bindingOk = false;
      },
      403,
      'forbidden',
    ],
    [
      'different token',
      (h: ReturnType<typeof authorized>) => {
        h.found.token.id = 'other';
      },
      403,
      'forbidden',
    ],
    [
      'different project',
      (h: ReturnType<typeof authorized>) => {
        h.found.project.id = 'other';
      },
      403,
      'forbidden',
    ],
    [
      'missing authority',
      (h: ReturnType<typeof authorized>) => {
        h.found.organizationPermissions = [];
      },
      403,
      'forbidden',
    ],
    [
      'unclaimed name',
      (h: ReturnType<typeof authorized>) => {
        h.deps.reads.source.mockResolvedValue([]);
      },
      409,
      'name_not_claimed',
    ],
    [
      'ambiguous claim',
      (h: ReturnType<typeof authorized>) => {
        h.deps.reads.source.mockResolvedValue([h.source, h.source]);
      },
      409,
      'name_not_claimed',
    ],
    [
      'project admission',
      (h: ReturnType<typeof authorized>) => {
        h.found.projectPermissions = ['project:packages:write'];
        h.found.organizationPermissions = [];
        h.deps.admitted.mockResolvedValue(false);
      },
      403,
      'not_admitted',
    ],
    [
      'organization admission',
      (h: ReturnType<typeof authorized>) => {
        h.deps.admitted.mockResolvedValue(false);
      },
      403,
      'not_admitted',
    ],
    [
      'paused source',
      (h: ReturnType<typeof authorized>) => {
        h.source.status = 'paused';
      },
      409,
      'source_paused',
    ],
    [
      'trusted package binding',
      (h: ReturnType<typeof authorized>) => {
        h.deps.reads.packageBinding.mockResolvedValue({ packageName: 'another' });
      },
      403,
      'package_binding',
    ],
  ] as const)('refuses %s without staging', async (_name, change, status, code) => {
    const h = authorized();
    change(h);
    const response = await createPublishService(h.deps as never)(h.context, 'widget');
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(h.context.request.bodyUsed).toBe(false);
    expect(h.deps.blob.stage).not.toHaveBeenCalled();
  });
});

it('maps exhausted staging admission to busy with retry advice', async () => {
  const h = authorized();
  h.deps.blob.stage.mockRejectedValue(new BlobAdmissionError());
  const publish = createPublishService({
    ...h.deps,
    clock: { now: () => new Date('2026-10-31T00:00:00.000Z') },
    registry: { caps: { publishTarballBytes: 50000000 }, publish: { requireLicense: false } },
  } as never);
  const response = await publish(h.context, 'widget');
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'busy' });
  expect(response.headers.get('retry-after')).toBe('10');
});

it.each([
  ['read scope', { scope: 'read' as const, readOnly: true }],
  ['read scope with inconsistent flag', { scope: 'read' as const, readOnly: false }],
  ['read only write scope', { scope: 'write' as const, readOnly: true }],
])('refuses snapshot %s before lookup or staging', async (_label, token) => {
  const h = authorized(token);
  const response = await createPublishService(h.deps as never)(h.context, 'widget');
  expect(response.status).toBe(403);
  expect(h.deps.lookupToken).not.toHaveBeenCalled();
  expect(h.deps.blob.stage).not.toHaveBeenCalled();
});

it('refuses non-JSON content before staging', async () => {
  const h = authorized();
  h.context.request.headers.set('content-type', 'text/plain');
  const response = await createPublishService(h.deps as never)(h.context, 'widget');
  expect(response.status).toBe(415);
  expect(h.deps.blob.stage).not.toHaveBeenCalled();
});

it('refuses an absent body before staging', async () => {
  const h = authorized({}, false);
  const response = await createPublishService(h.deps as never)(h.context, 'widget');
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: 'invalid_publish_body' });
  expect(h.deps.blob.stage).not.toHaveBeenCalled();
});

it.each([
  [400, 'invalid_publish_body', 'The publish body is invalid'],
  [503, 'unavailable', 'Service unavailable'],
  [503, 'staging_failed', 'Publish staging failed'],
  [411, 'length_required', 'Content-Length is required'],
] as const)('returns a fixed message without retry advice for %s %s', (status, code, message) => {
  const response = publishError(ctx(), status, code);
  expect(response.headers.has('retry-after')).toBe(false);
  return expect(response.json()).resolves.toMatchObject({ error: message, code });
});

it('requires a declared length before staging', async () => {
  const h = authorized();
  h.context.request.headers.delete('content-length');
  const response = await createPublishService(h.deps as never)(h.context, 'widget');
  expect(response.status).toBe(411);
  expect(await response.json()).toMatchObject({
    code: 'length_required',
    error: 'Content-Length is required',
  });
  expect(h.deps.blob.stage).not.toHaveBeenCalled();
  expect(h.context.request.bodyUsed).toBe(false);
});

it.each([
  ['2', 1],
  ['50000000', 37500000],
  ['66666666', 49999999],
] as const)('bounds the staging reservation by declared length %s', async (length, reservation) => {
  const h = authorized();
  h.context.request.headers.set('content-length', length);
  const publish = createPublishService({
    ...h.deps,
    clock: { now: () => new Date() },
    registry: { caps: { publishTarballBytes: 50000000 }, publish: { requireLicense: false } },
  } as never);
  await publish(h.context, 'widget');
  expect(h.deps.blob.stage).toHaveBeenCalledWith(h.context.org, expect.anything(), {
    maxBytes: reservation,
    mediaType: 'application/gzip',
  });
});

const runtimeNode = '../../../../runtime-node/src/codec/node-codec.ts';
const { nodeCodecs } = await import(new URL(runtimeNode, import.meta.url).href);

async function publishFixture(
  options: {
    tarballCap?: number;
    tarballSize?: number;
    metadataCap?: number;
    metadataExtra?: number;
    fillMetadataCap?: boolean;
    missingBlob?: boolean;
    bodyCap?: number;
    storageFailure?: boolean;
  } = {},
) {
  const { gzipSync } = await import('node:zlib');
  const { entry, archive, stream } = await import('../../test-support/npm-publish.js');
  const { createBlobUploadAdmission, createBlobStore } = await import('../../platform/blob.js');
  const { REGISTRY_DEFAULTS } = await import('../registry-config.js');
  const compressed = gzipSync(
    archive(
      entry('package/package.json', JSON.stringify({ name: 'widget', version: '1.0.0' })),
      ...(options.tarballSize
        ? [entry('package/payload.bin', 'x'.repeat(options.tarballSize - 20000))]
        : []),
    ),
    options.tarballSize ? { level: 0 } : {},
  );
  let bytes = compressed;
  if (options.tarballSize) {
    // A gzip comment fills the small gap after the uncompressed tar blocks.
    const comment = Buffer.alloc(options.tarballSize - compressed.length, 120);
    comment[comment.length - 1] = 0;
    bytes = Buffer.concat([compressed.subarray(0, 10), comment, compressed.subarray(10)]);
    bytes[3] = bytes[3]! | 16;
  }
  const document = {
    name: 'widget',
    readme: '# Widget\n' + 'x'.repeat(options.metadataExtra ?? 0),
    versions: { '1.0.0': { name: 'widget', version: '1.0.0' } },
    _attachments: { 'widget-1.0.0.tgz': { data: bytes.toString('base64'), length: bytes.length } },
  };
  let body = JSON.stringify(document);
  if (options.fillMetadataCap) {
    const current = Buffer.byteLength(body) - bytes.toString('base64').length - 1;
    document.readme += 'x'.repeat(REGISTRY_DEFAULTS.caps.publishMetadataBytes - current);
    body = JSON.stringify(document);
  }
  const metadataBytes = Buffer.byteLength(body) - bytes.toString('base64').length - 1;
  const h = authorized();
  h.found.project.id = '01J0ACME000000000000000001';
  const admission = createBlobUploadAdmission();
  const publishBlob = vi.fn<BlobMetadataPort['publish']>(async (_org, input) => ({
    ...input,
    purgeAfter: null,
  }));
  const discarded = vi.fn(async () => {});
  const putStaged = vi.fn(async (_handle: string, input: ReadableStream<Uint8Array>) => {
    if (options.storageFailure) throw new Error('private storage detail');
    const data = await new Response(input).arrayBuffer();
    const { createHash } = await import('node:crypto');
    return {
      sha256: createHash('sha256').update(new Uint8Array(data)).digest('hex'),
      size: data.byteLength,
    };
  });
  const blob = createBlobStore(
    {
      putStaged,
      promote: async () => {},
      discardStaged: discarded,
    } as never,
    {
      find: async () => null,
      reserve: async () => '1',
      publish: publishBlob,
    } as never,
    { admission, admissionWaitMs: 0 },
  );
  const discard = vi.fn(blob.discard);
  const stage = vi.fn(blob.stage);
  const publishVersion = vi.fn(async () => ({ approvalId: null, rev: '1' }));
  const publish = createPublishService({
    ...h.deps,
    reads: { ...h.deps.reads, blobId: async () => (options.missingBlob ? null : 'blob') },
    writeGuard: () => ({}),
    writer: { publishVersion },
    clock: { now: () => new Date('2026-10-31T00:00:00Z') },
    publicUrl: 'https://broker.test',
    registry: {
      ...REGISTRY_DEFAULTS,
      caps: {
        ...REGISTRY_DEFAULTS.caps,
        publishBodyBytes: options.bodyCap ?? REGISTRY_DEFAULTS.caps.publishBodyBytes,
        publishTarballBytes: options.tarballCap ?? bytes.length,
        publishMetadataBytes: options.metadataCap ?? metadataBytes,
      },
    },
    codecs: nodeCodecs,
    blob: { ...blob, discard, stage },
  } as never);
  const context = (length = Buffer.byteLength(body), suffix = '') => {
    const next = authorized().context;
    Object.assign(next, {
      projectId: h.found.project.id,
      principal: { kind: 'user', id: '01J0ACME000000000000000002' },
      requestId: '01J0ACME000000000000000003',
      request: new Request(h.context.request.url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'content-length': String(length) },
        body: stream(new TextEncoder().encode(body + suffix), 65536),
        duplex: 'half',
      } as RequestInit),
    });
    return next;
  };
  return {
    publish,
    context,
    body,
    discarded,
    discard,
    publishVersion,
    publishBlob,
    stage,
    putStaged,
    tarballBytes: bytes.length,
    metadataBytes,
  };
}

it('accepts two concurrent small publishes', async () => {
  const f = await publishFixture();
  const responses = await Promise.all([
    f.publish(f.context(), 'widget'),
    f.publish(f.context(), 'widget'),
  ]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
});

it('refuses a body longer than declared and discards its staging', async () => {
  const f = await publishFixture();
  const response = await f.publish(f.context(Buffer.byteLength(f.body), ' '), 'widget');
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ code: 'publish_body_too_large' });
  expect(f.discarded).toHaveBeenCalledOnce();
  expect(f.publishVersion).not.toHaveBeenCalled();
});

it.each(['', '-1', '1.5', '+2', '1e3', '9007199254740992', 'invalid'])(
  'refuses invalid declared length %s before staging',
  async (length) => {
    const h = authorized();
    h.context.request.headers.set('content-length', length);
    const response = await createPublishService(h.deps as never)(h.context, 'widget');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_publish_body' });
    expect(h.deps.blob.stage).not.toHaveBeenCalled();
  },
);

it('reserves the decoded declared body bound even when metadata makes it exceed the tarball cap', async () => {
  const h = authorized();
  h.context.request.headers.set('content-length', '1368');
  await createPublishService({
    ...h.deps,
    clock: { now: () => new Date() },
    registry: { caps: { publishTarballBytes: 1024 }, publish: { requireLicense: false } },
  } as never)(h.context, 'widget');
  expect(h.deps.blob.stage).toHaveBeenCalledWith(h.context.org, expect.anything(), {
    maxBytes: 1026,
    mediaType: 'application/gzip',
  });
});

it('publishes at the decoded tarball cap with maximal metadata', async () => {
  const f = await publishFixture({ metadataExtra: 4096 });
  expect(Math.floor((Buffer.byteLength(f.body) * 3) / 4)).toBeGreaterThan(f.tarballBytes);
  expect((await f.publish(f.context(), 'widget')).status).toBe(201);
  expect(f.discard).not.toHaveBeenCalled();
});

it('refuses a tarball one byte over its independent decoded cap', async () => {
  const size = (await publishFixture()).tarballBytes;
  const f = await publishFixture({ tarballCap: size - 1, metadataExtra: 4096 });
  const response = await f.publish(f.context(), 'widget');
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ code: 'tarball_too_large' });
});

it('refuses metadata one byte over its independent cap', async () => {
  const size = (await publishFixture({ metadataExtra: 4096 })).metadataBytes;
  const f = await publishFixture({ metadataExtra: 4096, metadataCap: size - 1 });
  const response = await f.publish(f.context(), 'widget');
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ code: 'publish_metadata_too_large' });
  expect(f.discarded).toHaveBeenCalledOnce();
  expect(f.publishVersion).not.toHaveBeenCalled();
});

it.each(Object.entries(API_ERROR_CODES))(
  'derives the %s response status from the API error table',
  (_code, definition) => {
    const response = publishError(ctx(), 499, _code);
    expect(response.status).toBe(definition.status);
    expect(response.headers.get('allow')).toBe(definition.status === 405 ? 'GET, HEAD' : null);
  },
);

it.each([
  ['admission', new BlobAdmissionError(), 'busy'],
  ['busy', new BlobBusyError(), 'busy'],
  ['storage', new Error('private staging detail'), 'staging_failed'],
] as const)(
  'cancels a stalled metadata scan on a %s staging failure',
  async (_label, error, code) => {
    const h = authorized();
    const cancelled = vi.fn();
    Object.assign(h.context, {
      request: new Request(h.context.request.url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'content-length': '4096' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"readme":"'));
          },
          cancel: cancelled,
        }),
        duplex: 'half',
      } as RequestInit),
    });
    h.deps.blob.stage.mockRejectedValue(error);
    const response = await createPublishService({
      ...h.deps,
      clock: { now: () => new Date() },
      registry: { caps: { publishTarballBytes: 50000000 }, publish: { requireLicense: false } },
      codecs: nodeCodecs,
    } as never)(h.context, 'widget');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code });
    expect(cancelled).toHaveBeenCalledOnce();
  },
  1000,
);

it.each([50000000, 50000001])(
  'checks a %i-byte tarball against the production 50 MB cap',
  async (tarballSize) => {
    const f = await publishFixture({
      tarballSize,
      tarballCap: 50000000,
      metadataExtra: 4096,
      fillMetadataCap: tarballSize === 50000000,
    });
    if (tarballSize === 50000000) expect(f.metadataBytes).toBe(10000000);
    expect(f.tarballBytes).toBe(tarballSize);
    const response = await f.publish(f.context(), 'widget');
    expect(response.status).toBe(tarballSize === 50000000 ? 201 : 413);
    if (tarballSize > 50000000)
      expect(await response.json()).toMatchObject({ code: 'tarball_too_large' });
  },
  60000,
);

it('refuses catalogue writes when the real store promotes a blob but its row cannot be read', async () => {
  const f = await publishFixture({ missingBlob: true });
  const response = await f.publish(f.context(), 'widget');
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: 'unavailable',
    error: 'Service unavailable',
  });
  expect(f.publishBlob).toHaveBeenCalledOnce();
  expect(f.discard).not.toHaveBeenCalled();
  expect(f.publishVersion).not.toHaveBeenCalled();
});

it.each([80000001, 90000000])(
  'refuses declared body length %i above the default body cap before real-store staging',
  async (length) => {
    const f = await publishFixture();
    const context = f.context(length);
    const response = await f.publish(context, 'widget');
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'publish_body_too_large' });
    expect(context.request.bodyUsed).toBe(false);
    expect(f.stage).not.toHaveBeenCalled();
    expect(f.putStaged).not.toHaveBeenCalled();
    expect(f.publishVersion).not.toHaveBeenCalled();
  },
);

it('maps a real-store reservation above its fixed ceiling to the tarball size limit', async () => {
  const f = await publishFixture({ bodyCap: 100000000 });
  const response = await f.publish(f.context(90000000), 'widget');
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ code: 'tarball_too_large' });
  expect(f.stage).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
    maxBytes: 67500000,
    mediaType: 'application/gzip',
  });
  expect(f.putStaged).not.toHaveBeenCalled();
  expect(f.publishVersion).not.toHaveBeenCalled();
});

it('preserves a genuine real-store storage failure as staging_failed', async () => {
  const f = await publishFixture({ storageFailure: true });
  const response = await f.publish(f.context(), 'widget');
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: 'staging_failed',
    error: 'Publish staging failed',
  });
  expect(f.putStaged).toHaveBeenCalledOnce();
  expect(f.publishVersion).not.toHaveBeenCalled();
});
