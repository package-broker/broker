import { describe, expect, it, vi } from 'vitest';
import type { PackageAccess } from '../catalogue/package-access.js';
import { createPolicyPackageAccess } from '../catalogue/policy-access.js';
import type { DistTarget } from '../db/catalogue.js';
import type { PolicyRule } from '../db/registry-policy.js';
import { systemClock } from '../ids.js';
import type { FetchLeases } from '../ingest/coalesce.js';
import { parseSha256, type CoreBlobStore } from '../platform/blob.js';
import { policyRule, sessionSetup } from '../test-support/registry-policy-session.js';
import { createDistService, DIST_CACHE_CONTROL, type DistServeOptions } from './dist-service.js';
import { RegistryPolicyUnavailableError } from './policy/errors.js';

const VERSION = '01J0VERSION00000000000000A';
const SHA = parseSha256('a'.repeat(64));
const BLOCK = '01J0P0000000000000000000B1';

function block(): PolicyRule {
  return policyRule(BLOCK, { ecosystem: 'composer', packageKey: 'acme/lib', members: ['1.0.0.0'] });
}

function rig(
  setup: { blob?: boolean; held?: boolean; rules?: PolicyRule[]; auditFails?: boolean } = {},
) {
  const state = {
    gets: 0,
    plans: 0,
    builds: 0,
    recorded: [] as string[],
    cancelled: 0,
    onGet: () => undefined as void,
    onResolve: () => undefined as void,
    current: 2,
    filled: false,
  };
  const target = (revision: number): DistTarget => ({
    versionId: VERSION,
    revision,
    current: revision === state.current,
    packageId: 'K',
    sourceId: 'S',
    status: 'active',
    blob:
      setup.blob === false
        ? null
        : {
            id: 'blob_1',
            sha256: SHA,
            sizeBytes: 3,
            mediaType: 'application/zip',
            refetchable: true,
          },
    fetch: {
      sourceRef: null,
      upstreamDistUrl: 'https://upstream.test/lib.zip',
      distType: 'zip',
      composerShasum: null,
      npmIntegrity: null,
      npmShasum: null,
    },
    facts: {
      version: '1.0.0',
      versionNormalized: '1.0.0.0',
      publishedAt: '2025-01-01T00:00:00.000Z',
      publishedAtBasis: 'release_date',
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  });
  const raw = {
    async dist(_actor, _ecosystem, _key, request) {
      state.onResolve();
      return request.by === 'id' &&
        request.versionId === VERSION &&
        request.revision <= state.current
        ? { ...target(request.revision), ...(state.filled ? { blob: filledBlob } : {}) }
        : null;
    },
  } as Pick<PackageAccess, 'dist'>;
  const filledBlob = {
    id: 'blob_filled',
    sha256: SHA,
    sizeBytes: 3,
    mediaType: 'application/zip',
    refetchable: true,
  };
  const store = {
    async get() {
      state.gets += 1;
      state.onGet();
      return {
        info: {
          generation: 'g',
          sha256: SHA,
          size: 3,
          mediaType: 'application/zip',
          purgeAfter: null,
        },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode('zip'));
            controller.close();
          },
          cancel() {
            state.cancelled += 1;
          },
        }),
      };
    },
    async head() {
      return state.filled
        ? { generation: 'g', sha256: SHA, size: 3, mediaType: 'application/zip', purgeAfter: null }
        : null;
    },
  } as unknown as Pick<CoreBlobStore, 'get' | 'head'>;
  const leases: FetchLeases = {
    acquire: async (_ctx, key, owner) => (setup.held ? 'held' : { key, owner, fence: 1 }),
    renew: async () => true,
    release: async () => undefined,
  };
  const service = createDistService({
    access: raw,
    store,
    leases,
    clock: systemClock,
    leaseKey: async (parts) => parts.join(':'),
    writeGuard: () => {
      throw new Error('unused');
    },
    planFetch: async () => {
      state.plans += 1;
      return null;
    },
    enqueueNpmVcsBuild: async () => {
      state.builds += 1;
      return false;
    },
    recorder: { record: (_ctx, blobId) => void state.recorded.push(blobId) },
    coalesce: { waitBudgetMs: 200, pollMs: 5 },
  });
  const policy = sessionSetup({
    rules: setup.rules ?? [],
    input: { ecosystem: 'composer', kind: 'dist' },
    ...(setup.auditFails ? { auditFails: true } : {}),
  });
  const serve = (revision: number, governed = true) => {
    const session = policy.open({ client: { family: 'composer', version: '2.7.1' } });
    const options: DistServeOptions = governed
      ? {
          policy: {
            session,
            access: createPolicyPackageAccess(raw as unknown as PackageAccess, session),
          },
        }
      : {};
    return service.serve(
      session.actor,
      { ecosystem: 'composer', key: 'acme/lib', versionId: VERSION, revision },
      options,
    );
  };
  return { state, policy, serve };
}

describe('dist precheck and final seal', () => {
  it('without policy the existing immutable headers and immediate recording stay', async () => {
    const { serve, state } = rig({ rules: [block()] });
    const result = await serve(2, false);
    expect(result.kind).toBe('file');
    if (result.kind === 'file')
      expect(result.headers.get('cache-control')).toBe(DIST_CACHE_CONTROL);
    expect(state.recorded).toEqual(['blob_1']);
  });

  it('an allowed governed file revalidates instead of being immutable, and is recorded after the seal', async () => {
    const { serve, state } = rig();
    const result = await serve(2);
    expect(result.kind).toBe('file');
    if (result.kind !== 'file') return;
    expect(result.headers.get('cache-control')).toBe('private, no-cache');
    expect(result.headers.get('cache-control')).not.toContain('immutable');
    expect(await new Response(result.body).text()).toBe('zip');
    expect(state.recorded).toEqual(['blob_1']);
  });

  it('a warm block refuses before any blob read, fetch plan or build', async () => {
    const warm = rig({ rules: [block()] });
    expect(await warm.serve(2)).toEqual({ kind: 'not_found' });
    expect(warm.state.gets).toBe(0);
    expect(warm.policy.audit.events).toHaveLength(1);
    const cold = rig({ blob: false, rules: [block()] });
    expect(await cold.serve(2)).toEqual({ kind: 'not_found' });
    expect(cold.state).toMatchObject({ gets: 0, plans: 0, builds: 0 });
  });

  it('a block committed after the blob is opened cancels the body and serves nothing', async () => {
    const { serve, state, policy } = rig();
    state.onGet = () => {
      if (state.gets === 1) policy.policy.commit([block()]);
    };
    expect(await serve(2)).toEqual({ kind: 'not_found' });
    expect(state.cancelled).toBe(1);
    expect(state.recorded).toEqual([]);
    expect(JSON.parse(policy.audit.events[0]!.payloadJson)).toMatchObject({
      changes: { read_kind: { new: 'dist' }, version_id: { new: VERSION } },
    });
  });

  it('an old revision URL is decided by the current version and cannot escape a block', async () => {
    const { serve, state } = rig({ rules: [block()] });
    expect(await serve(1)).toEqual({ kind: 'not_found' });
    expect(state.gets).toBe(0);
  });

  it('a waiter whose fill completes under a new block cancels the opened body and serves nothing', async () => {
    const { serve, state, policy } = rig({ blob: false, held: true });
    let resolves = 0;
    state.onResolve = () => {
      resolves += 1;
      if (resolves === 2) {
        state.filled = true;
        policy.policy.commit([block()]);
      }
    };
    expect(await serve(2)).toEqual({ kind: 'not_found' });
    expect(state.gets).toBe(1);
    expect(state.cancelled).toBe(1);
    expect(state.recorded).toEqual([]);
    expect(policy.audit.events).toHaveLength(1);
  });

  it('a direct-denial audit failure is the fixed 503 and no bytes', async () => {
    const { serve, state } = rig({ rules: [block()], auditFails: true });
    await expect(serve(2)).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
    expect(state.gets).toBe(0);
  });

  it('a change on every attempt cancels each opened body and ends in the fixed 503', async () => {
    const { serve, state, policy } = rig();
    state.onGet = () => policy.policy.commit([]);
    await expect(serve(2)).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
    expect(state.cancelled).toBe(2);
    expect(state.recorded).toEqual([]);
  });
});

void vi;
