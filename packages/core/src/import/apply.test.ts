import { describe, expect, it, vi } from 'vitest';
import { delegatedMutationFence, fenceKind } from '../authz/fence.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import type { Sha256 } from '../platform/blob.js';
import { parseManifest, planHash, type Manifest } from './manifest.js';
import {
  runImportApply,
  type ImportApplyDeps,
  type ImportApplyStore,
  type ImportApplyRun,
} from './apply.js';

type Item = Manifest['items'][number];
const ctx = orgContext('org');
const runId = '01J0QPAD000000000000000000';
const approver = '01J0USER000000000000000000';
const now = '2026-10-19T09:00:00.000Z';
const job = { id: 'job', owner: 'worker', fence: 1 };
const project = (n: number): Item => ({
  type: 'project',
  external_ref: `p${n}`,
  slug: `project-${n}`,
  name: `Project ${n}`,
});
const role: Item = {
  type: 'role',
  external_ref: 'r',
  key: 'importer',
  name: 'Importer',
  scope: 'organization',
  permissions: ['org:import:approve'],
};
const grant: Item = {
  type: 'grant',
  external_ref: 'g',
  scope: 'organization',
  project: null,
  role: { ref: 'r' },
  subject: { type: 'group', provider: 'okta', value: 'Operators' },
};

async function setup(items: readonly Item[] = [project(1)], widening: Manifest['widening'] = []) {
  const manifest = { version: 1, source_system: 'test', items, widening };
  const parsed = parseManifest(manifest);
  if (!parsed.ok) throw new Error('invalid fixture');
  const run: ImportApplyRun = {
    id: runId,
    state: 'applying',
    planHash: await planHash(parsed.data),
    approvedAt: now,
    approvedByUserId: approver,
    manifestBlobSha256: 'a'.repeat(64) as Sha256,
  };
  const refs = new Set<string>();
  const rows: string[] = [];
  const store = {
    loadRun: vi.fn<ImportApplyStore['loadRun']>().mockImplementation(async () => run),
    appliedRefs: vi.fn<ImportApplyStore['appliedRefs']>().mockImplementation(async () => [...refs]),
    rolePermissions: vi
      .fn<ImportApplyStore['rolePermissions']>()
      .mockResolvedValue(['project:read']),
    applyChunk: vi
      .fn<ImportApplyStore['applyChunk']>()
      .mockImplementation(async (_, fence, input) => {
        expect(fenceKind(fence)).toBe('delegated');
        for (const item of input.items) {
          const key = `${item.type}:${item.external_ref}`;
          expect(refs.has(key)).toBe(false);
          refs.add(key);
          rows.push(key);
        }
        return { ok: true };
      }),
    finish: vi.fn<ImportApplyStore['finish']>().mockResolvedValue(undefined),
  };
  const blobs = {
    get: vi.fn<ImportApplyDeps['blobs']['get']>().mockImplementation(async () => ({
      info: {
        generation: '',
        sha256: run.manifestBlobSha256!,
        size: 1,
        mediaType: 'application/json',
        purgeAfter: null,
      },
      body: new Response(JSON.stringify(manifest)).body!,
    })),
  };
  let counter = 0;
  const deps: ImportApplyDeps = {
    store,
    blobs,
    clock: fixedClock(now),
    ids: { ulid: () => `01J0AUDIT${String(++counter).padStart(17, '0')}` },
  };
  const fences = vi.fn((user: string, id: string, expected: Readonly<Record<string, number>>) =>
    delegatedMutationFence(user, id, job, expected),
  );
  const execute = () => runImportApply(deps, ctx, { runId }, fences);
  return { run, store, blobs, deps, fences, rows, refs, execute };
}

function noItems(s: Awaited<ReturnType<typeof setup>>) {
  expect(s.store.applyChunk).not.toHaveBeenCalled();
}

function failed(s: Awaited<ReturnType<typeof setup>>, reason: string) {
  expect(s.store.finish).toHaveBeenCalledExactlyOnceWith(ctx, expect.anything(), {
    runId,
    outcome: { failed: reason },
    now,
  });
}

describe('runImportApply', () => {
  it('refuses a manifest-role session-only grant without widening', async () => {
    const s = await setup([role, grant]);
    expect(await s.execute()).toEqual({ status: 'failed', reason: 'widening_refused' });
    noItems(s);
    expect(s.rows).not.toContain('grant:g');
    failed(s, 'widening_refused');
  });

  it('applies the same grant explicitly listed under widening', async () => {
    const s = await setup([role, grant], [{ type: 'grant', external_ref: 'g' }]);
    expect(await s.execute()).toEqual({ status: 'applied' });
    expect(s.rows).toEqual(['role:r', 'grant:g']);
    expect(s.store.applyChunk.mock.calls[0]![2].widening).toEqual(['g']);
    expect(s.store.rolePermissions).not.toHaveBeenCalled();
  });

  it('refuses a session-only grant to an existing role without widening', async () => {
    const s = await setup([{ ...grant, role: { existing: 'importer' } }]);
    s.store.rolePermissions.mockResolvedValue(['org:import:approve']);
    expect(await s.execute()).toEqual({ status: 'failed', reason: 'widening_refused' });
    noItems(s);
    expect(s.store.rolePermissions).toHaveBeenCalledWith(ctx, 'importer');
  });

  it('refuses an unresolved existing role', async () => {
    const s = await setup([{ ...grant, role: { existing: 'missing' } }]);
    s.store.rolePermissions.mockResolvedValue(null);
    expect(await s.execute()).toEqual({ status: 'failed', reason: 'conflict' });
    noItems(s);
  });

  it('does not apply a hash mismatch and finishes failed exactly once', async () => {
    const s = await setup();
    s.run.planHash = 'b'.repeat(64);
    expect(await s.execute()).toEqual({ status: 'failed', reason: 'plan_hash_mismatch' });
    noItems(s);
    expect(s.rows).toEqual([]);
    failed(s, 'plan_hash_mismatch');
  });

  it('resumes after a crash following chunk 1 without duplicating its rows', async () => {
    const s = await setup(Array.from({ length: 51 }, (_, i) => project(i)));
    const apply = s.store.applyChunk.getMockImplementation()!;
    s.store.applyChunk.mockImplementationOnce(async (...args) => {
      await apply(...args);
      throw new Error('simulated crash after commit');
    });
    await expect(s.execute()).rejects.toThrow('simulated crash after commit');
    expect(s.rows).toHaveLength(48);
    expect(s.store.finish).not.toHaveBeenCalled();
    s.fences.mockClear();
    expect(await s.execute()).toEqual({ status: 'applied' });
    expect(s.rows).toHaveLength(51);
    expect(new Set(s.rows).size).toBe(51);
    // One issuer for the remaining chunk; finish reuses its lease-bound fence.
    expect(s.fences).toHaveBeenCalledExactlyOnceWith(approver, runId, {});
  });

  it('finishes failed when the suspended-approver guard refuses the current chunk', async () => {
    const s = await setup();
    s.store.applyChunk.mockResolvedValue({ ok: false, reason: 'guard' });
    expect(await s.execute()).toEqual({ status: 'failed', reason: 'guard_failed' });
    expect(s.rows).toEqual([]);
    failed(s, 'guard_failed');
  });

  it('keeps chunk 1 and fails without writing chunk 2 after suspension', async () => {
    const s = await setup(Array.from({ length: 51 }, (_, i) => project(i)));
    const apply = s.store.applyChunk.getMockImplementation()!;
    s.store.applyChunk
      .mockImplementationOnce(apply)
      .mockResolvedValueOnce({ ok: false, reason: 'guard' });
    expect(await s.execute()).toEqual({ status: 'failed', reason: 'guard_failed' });
    expect(s.rows).toHaveLength(48);
    expect(s.rows).not.toContain('project:p48');
    failed(s, 'guard_failed');
    expect(s.store.finish.mock.calls[0]![1]).toBe(s.store.applyChunk.mock.calls[1]![1]);
  });

  it('stops on a chunk conflict', async () => {
    const s = await setup();
    s.store.applyChunk.mockResolvedValue({ ok: false, reason: 'conflict' });
    expect(await s.execute()).toEqual({ status: 'failed', reason: 'conflict' });
    expect(s.rows).toEqual([]);
    failed(s, 'conflict');
  });

  it('only applies listed items and scopes every call by organization', async () => {
    const s = await setup();
    await s.execute();
    expect(s.rows).toEqual(['project:p1']);
    for (const method of Object.values(s.store)) {
      for (const args of method.mock.calls) expect(args[0]).toEqual(ctx);
    }
    expect(s.blobs.get).toHaveBeenCalledWith(ctx, s.run.manifestBlobSha256);
  });

  it('pauses sources and omits credential references from every store argument', async () => {
    const sentinel = 'env:CREDENTIAL_SENTINEL';
    const s = await setup([
      {
        type: 'source',
        external_ref: 's',
        name: 'registry',
        ecosystem: 'composer',
        source_type: 'composer_repository',
        project: null,
        url: 'https://packages.example.test/',
        credential_ref: sentinel,
        config: {
          selection: { packages: [], patterns: [], expandPatterns: false },
          distHosts: [],
          mirrorsFallback: false,
        },
      },
    ]);
    expect(await s.execute()).toEqual({ status: 'applied' });
    expect(s.store.applyChunk.mock.calls[0]![2].items[0]).toMatchObject({ status: 'paused' });
    for (const method of Object.values(s.store)) {
      const args = JSON.stringify(method.mock.calls);
      expect(args).not.toContain(sentinel);
      expect(args).not.toContain('credential_ref');
    }
  });

  it.each([
    ['missing run', null],
    ['no approver', { approvedByUserId: null }],
    ['no approval', { approvedAt: null }],
    ['future approval', { approvedAt: '2099-01-01T00:00:00.000Z' }],
    ['planned run', { state: 'planned' }],
  ] as const)('does not start an unapproved run: %s', async (_, override) => {
    const s = await setup();
    if (override === null) s.store.loadRun.mockResolvedValue(null);
    else Object.assign(s.run, override);
    expect(await s.execute()).toEqual({ status: 'not_approved' });
    noItems(s);
    expect(s.store.finish).not.toHaveBeenCalled();
    expect(s.fences).not.toHaveBeenCalled();
  });

  it('issues one fence per chunk with the stored approver and run', async () => {
    const s = await setup(Array.from({ length: 51 }, (_, i) => project(i)));
    await s.execute();
    expect(s.store.applyChunk.mock.calls.map((call) => call[2].items.length)).toEqual([48, 3]);
    expect(s.fences.mock.calls).toEqual([
      [approver, runId, {}],
      [approver, runId, {}],
    ]);
  });

  it('skips an entirely journaled manifest without applying or auditing items', async () => {
    const s = await setup();
    s.refs.add('project:p1');
    await s.execute();
    noItems(s);
    expect(s.rows).toEqual([]);
    // The sole issuance is for finish, with no chunk to supply a fence.
    expect(s.fences).toHaveBeenCalledTimes(1);
  });

  it('fails safely when the manifest blob is unavailable', async () => {
    const s = await setup();
    s.blobs.get.mockResolvedValue(null);
    expect(await s.execute()).toEqual({ status: 'failed', reason: 'manifest_unavailable' });
    noItems(s);
    failed(s, 'manifest_unavailable');
  });

  it('fails safely when the blob reader throws', async () => {
    const s = await setup();
    s.blobs.get.mockImplementation(async () => {
      throw new Error('unavailable');
    });
    expect(await s.execute()).toEqual({ status: 'failed', reason: 'manifest_unavailable' });
    noItems(s);
  });

  it('fails safely on invalid JSON', async () => {
    const s = await setup();
    const get = s.blobs.get.getMockImplementation()!;
    s.blobs.get.mockImplementation(async (...args) => {
      const blob = (await get(...args))!;
      return { ...blob, body: new Response('{').body! };
    });
    expect(await s.execute()).toEqual({ status: 'failed', reason: 'manifest_unavailable' });
    noItems(s);
    failed(s, 'manifest_unavailable');
  });

  it('fails safely on an oversized blob and cancels the stream', async () => {
    const s = await setup();
    const cancel = vi.fn();
    const get = s.blobs.get.getMockImplementation()!;
    s.blobs.get.mockImplementation(async (...args) => {
      const blob = (await get(...args))!;
      return {
        ...blob,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1048577));
          },
          cancel,
        }),
      };
    });
    expect(await s.execute()).toEqual({ status: 'failed', reason: 'manifest_unavailable' });
    noItems(s);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('orders all entity types and stages one accurate audit per item', async () => {
    const s = await setup([
      {
        type: 'version_override',
        external_ref: 'v',
        source: { ref: 's' },
        package: 'acme/widgets',
        version: '1.0.0',
        published_at: now,
        basis: 'source_release',
      },
      { ...grant, role: { existing: 'reader' } },
      {
        type: 'attachment',
        external_ref: 'a',
        source: { ref: 's' },
        project: { ref: 'p1' },
        precedence: 0,
      },
      {
        type: 'name',
        external_ref: 'n',
        source: { ref: 's' },
        ecosystem: 'composer',
        pattern: 'acme/*',
      },
      {
        type: 'source',
        external_ref: 's',
        name: 'registry',
        ecosystem: 'composer',
        source_type: 'composer_repository',
        project: null,
        url: 'https://packages.example.test/',
        credential_ref: null,
        config: {
          selection: { packages: [], patterns: [], expandPatterns: false },
          distHosts: [],
          mirrorsFallback: false,
        },
      },
      project(1),
      role,
    ]);
    expect(await s.execute()).toEqual({ status: 'applied' });
    const chunk = s.store.applyChunk.mock.calls[0]![2];
    expect(chunk.items.map((item) => item.type)).toEqual([
      'role',
      'project',
      'source',
      'name',
      'attachment',
      'grant',
      'version_override',
    ]);
    expect(chunk.audits.map((audit) => audit.action)).toEqual([
      'role.create',
      'project.create',
      'source.create',
      'registered_name.add',
      'source.attach',
      'grant.create',
      'version.published_at_set',
    ]);
    const audit = chunk.audits.at(-1)!;
    expect(audit.target).toEqual({ type: 'version', id: null });
    expect(audit.projectId).toBeNull();
    expect(JSON.parse(audit.payloadJson)).toMatchObject({
      op_id: runId,
      changes: {
        package_name: { new: 'acme/widgets' },
        version: { new: '1.0.0' },
        published_at: { new: now },
        published_at_basis: { new: 'source_release' },
      },
    });
    expect(JSON.stringify(chunk.audits)).not.toContain('Operators');
  });
});

describe('import review regressions', () => {
  it.each([201, 428])(
    'applies a %i-character package and maximum version without truncation',
    async (length) => {
      const item: Item = {
        type: 'version_override',
        external_ref: 'v',
        source: { existing: { project: null, name: 'registry' } },
        package: 'a/'.padEnd(length, 'a'),
        version: 'dev-'.padEnd(256, 'a'),
        published_at: now,
        basis: 'import_time',
      };
      const s = await setup([item]);
      expect(await s.execute()).toEqual({ status: 'applied' });
      const audit = s.store.applyChunk.mock.calls[0]![2].audits[0]!;
      expect(JSON.parse(audit.payloadJson).changes).toMatchObject({
        package_name: { new: item.package },
        version: { new: item.version },
      });
    },
  );

  it.each([{ ref: 'p1' }, { existing: 'existing-project' }])(
    'persists project attribution resolved atomically from %j',
    async (projectRef) => {
      const s = await setup([
        project(1),
        {
          type: 'source',
          external_ref: 's',
          name: 'registry',
          ecosystem: 'composer',
          source_type: 'composer_repository',
          project: projectRef,
          url: 'https://packages.example.test/',
          credential_ref: null,
          config: {
            selection: { packages: [], patterns: [], expandPatterns: false },
            distHosts: [],
            mirrorsFallback: false,
          },
        },
        {
          type: 'attachment',
          external_ref: 'a',
          project: projectRef,
          source: { ref: 's' },
          precedence: 0,
        },
        { ...grant, scope: 'project', project: projectRef, role: { existing: 'reader' } },
        {
          type: 'version_override',
          external_ref: 'v',
          source: { ref: 's' },
          package: 'acme/widgets',
          version: '1.0.0',
          published_at: now,
          basis: 'import_time',
        },
      ]);
      const persisted: Array<{ action: string; projectId: string | null }> = [];
      const apply = s.store.applyChunk.getMockImplementation()!;
      s.store.applyChunk.mockImplementation(async (...args) => {
        const input = args[2];
        // Model the adapter's same-transaction project resolution and audit persistence.
        const projects = input.auditProjects;
        for (const [index, audit] of input.audits.entries()) {
          const reference = projects[index];
          if (['source.create', 'source.attach', 'project_grant.create'].includes(audit.action)) {
            expect(reference).toEqual(projectRef);
          }
          persisted.push({
            action: audit.action,
            projectId:
              reference == null
                ? audit.projectId
                : 'ref' in reference
                  ? 'resolved-new-project'
                  : 'resolved-existing-project',
          });
        }
        return apply(...args);
      });
      expect(await s.execute()).toEqual({ status: 'applied' });
      const projectId = 'ref' in projectRef ? 'resolved-new-project' : 'resolved-existing-project';
      for (const action of ['source.create', 'source.attach', 'project_grant.create']) {
        expect(persisted.find((audit) => audit.action === action)?.projectId).toBe(projectId);
      }
      expect(
        persisted.find((audit) => audit.action === 'version.published_at_set')?.projectId,
      ).toBeNull();
    },
  );
});
