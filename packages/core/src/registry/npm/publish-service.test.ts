import { BlobAdmissionError } from '../../platform/blob.js';
import { setAccessContext, type AccessContextSnapshot } from '../../authz/access-context.js';
import { describe, expect, it, vi } from 'vitest';
import { createPublishService, publishError } from './publish-service.js';
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
    hasPublishPolicy: () => false,
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
    [
      'scan policy',
      (h: ReturnType<typeof authorized>) => {
        h.deps.hasPublishPolicy = () => true;
      },
      503,
      'scan_gate_unavailable',
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
  [503, 'scan_gate_unavailable', 'The publish scan gate is unavailable'],
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

async function publishFixture() {
  const { gzipSync } = await import('node:zlib');
  const { entry, archive, stream } = await import('../../test-support/npm-publish.js');
  const { createBlobUploadAdmission, createBlobStore } = await import('../../platform/blob.js');
  const { REGISTRY_DEFAULTS } = await import('../registry-config.js');
  const bytes = gzipSync(
    archive(entry('package/package.json', JSON.stringify({ name: 'widget', version: '1.0.0' }))),
  );
  const body = JSON.stringify({
    name: 'widget',
    versions: { '1.0.0': { name: 'widget', version: '1.0.0' } },
    _attachments: { 'widget-1.0.0.tgz': { data: bytes.toString('base64'), length: bytes.length } },
  });
  const h = authorized();
  h.found.project.id = '01J0ACME000000000000000001';
  const admission = createBlobUploadAdmission();
  const discarded = vi.fn(async () => {});
  const publish = createPublishService({
    ...h.deps,
    reads: { ...h.deps.reads, blobId: async () => 'blob' },
    writeGuard: () => ({}),
    writer: { publishVersion: async () => ({ approvalId: null, rev: '1' }) },
    clock: { now: () => new Date('2026-10-31T00:00:00Z') },
    publicUrl: 'https://broker.test',
    registry: REGISTRY_DEFAULTS,
    codecs: nodeCodecs,
    blob: {
      ...createBlobStore(
        {
          putStaged: async (_handle: string, input: ReadableStream<Uint8Array>) => {
            const data = await new Response(input).arrayBuffer();
            const { createHash } = await import('node:crypto');
            return {
              sha256: createHash('sha256').update(new Uint8Array(data)).digest('hex'),
              size: data.byteLength,
            };
          },
          discardStaged: discarded,
        } as never,
        {} as never,
        { admission, admissionWaitMs: 0 },
      ),
      promote: async (_org: unknown, staged: unknown) => staged,
      discard: discarded,
    },
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
        body: stream(new TextEncoder().encode(body + suffix)),
        duplex: 'half',
      } as RequestInit),
    });
    return next;
  };
  return { publish, context, body, discarded };
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

it('refuses a declared length whose tarball bound exceeds the effective publish cap before staging', async () => {
  const h = authorized();
  h.context.request.headers.set('content-length', '1368');
  const response = await createPublishService({
    ...h.deps,
    registry: { caps: { publishTarballBytes: 1024 } },
  } as never)(h.context, 'widget');
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ code: 'tarball_too_large' });
  expect(h.deps.blob.stage).not.toHaveBeenCalled();
  expect(h.context.request.bodyUsed).toBe(false);
});
