import { auditEvent, type AuditEvent, type AuditEventInput } from '../audit/actions.js';
import type { DelegatedMutationFence } from '../authz/fence.js';
import { PERMISSIONS } from '../authz/permissions.js';
import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import type { BlobStore, Sha256 } from '../platform/blob.js';
import { MAX_MANIFEST_BYTES, parseManifest, planHash, type Manifest } from './manifest.js';
import {
  validImportApprovalTimestamp,
  type ImportRunJobPayload,
  type ImportRunState,
} from './run-service.js';

export type DelegatedFenceIssuer = (
  approverUserId: string,
  runId: string,
  expected: Readonly<Record<string, number>>,
) => DelegatedMutationFence;

export type ImportApplyFailure =
  'plan_hash_mismatch' | 'manifest_unavailable' | 'widening_refused' | 'guard_failed' | 'conflict';

export type ImportApplyResult =
  | { status: 'applied' }
  | { status: 'failed'; reason: ImportApplyFailure }
  | { status: 'not_approved' };

export interface ImportApplyRun {
  id: string;
  state: ImportRunState;
  planHash: string | null;
  approvedAt: string | null;
  approvedByUserId: string | null;
  manifestBlobSha256: Sha256 | null;
}

type Item = Manifest['items'][number];
type Source = Extract<Item, { type: 'source' }>;
type ProjectRef = NonNullable<Source['project']>;
export type ImportApplyItem =
  Exclude<Item, Source> | (Omit<Source, 'credential_ref'> & { readonly status: 'paused' });

/**
 * Reads are organization-scoped. applyChunk atomically guards the approver, approved run and
 * lease, resolves references and revisions, saves before-images, and writes items, audits and
 * import_ref journal rows. It rechecks live grant-role permissions against widening in the same
 * batch; a concurrent permissions change that would widen access returns conflict.
 * auditProjects is aligned with items and audits. Before persisting each audit, resolve its
 * non-null project reference in this organization and set event.projectId to the row id;
 * an unresolved reference is a conflict, never an organization-level audit. Null stays null.
 * A duplicate journal key must never repeat an item mutation or audit.
 * finish guards only the lease and run, so loss of approver authority can still fail the run.
 */
export interface ImportApplyStore {
  loadRun(ctx: OrgContext, runId: string): Promise<ImportApplyRun | null>;
  appliedRefs(ctx: OrgContext, runId: string): Promise<readonly string[]>;
  /** Existing manifest role references are role keys, resolved within this organization. */
  rolePermissions(ctx: OrgContext, roleId: string): Promise<readonly string[] | null>;
  applyChunk(
    ctx: OrgContext,
    fence: DelegatedMutationFence,
    input: {
      readonly runId: string;
      readonly items: readonly ImportApplyItem[];
      readonly audits: readonly AuditEvent[];
      readonly auditProjects: readonly (ProjectRef | null)[];
      readonly widening: readonly string[];
      readonly now: string;
    },
  ): Promise<{ ok: true } | { ok: false; reason: 'guard' | 'conflict' }>;
  finish(
    ctx: OrgContext,
    fence: DelegatedMutationFence,
    input: {
      readonly runId: string;
      readonly outcome: 'applied' | { failed: ImportApplyFailure };
      readonly now: string;
    },
  ): Promise<void>;
}

export interface ImportApplyDeps {
  readonly store: ImportApplyStore;
  readonly blobs: Pick<BlobStore, 'get'>;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
}

const ORDER: Readonly<Record<Item['type'], number>> = {
  role: 0,
  project: 1,
  source: 2,
  name: 3,
  attachment: 4,
  grant: 5,
  version_override: 6,
};
const SESSION_ONLY: ReadonlySet<string> = new Set(
  PERMISSIONS.filter((permission) => permission.sessionOnly).map((permission) => permission.name),
);

async function readManifest(deps: ImportApplyDeps, ctx: OrgContext, key: Sha256 | null) {
  if (key === null) return null;
  try {
    const blob = await deps.blobs.get(ctx, key);
    if (blob === null) return null;
    const reader = blob.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_MANIFEST_BYTES) return null;
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const parsed = parseManifest(JSON.parse(text));
    return parsed.ok ? parsed.data : null;
  } catch {
    return null;
  }
}

function applyItem(item: Item): ImportApplyItem {
  if (item.type !== 'source') return item;
  const { credential_ref: credentialRef, ...source } = item;
  void credentialRef;
  return { ...source, status: 'paused' };
}

function auditProject(item: Item): ProjectRef | null {
  switch (item.type) {
    case 'project':
      return { ref: item.external_ref };
    case 'source':
    case 'attachment':
    case 'grant':
      return item.project;
    default:
      return null;
  }
}

function itemAudit(item: Item): Pick<AuditEventInput, 'action' | 'target' | 'changes'> {
  const target = { type: item.type, id: null };
  switch (item.type) {
    case 'role':
      return {
        action: 'role.create',
        target,
        changes: {
          key: { new: item.key },
          name: { new: item.name },
          scope: { new: item.scope },
          permissions: { new: item.permissions },
        },
      };
    case 'project':
      return {
        action: 'project.create',
        target,
        changes: {
          slug: { new: item.slug },
          name: { new: item.name },
        },
      };
    case 'source':
      return {
        action: 'source.create',
        target,
        changes: {
          name: { new: item.name },
          type: { new: item.source_type },
          ecosystem: { new: item.ecosystem },
        },
      };
    case 'name':
      return {
        action: 'registered_name.add',
        target: { type: 'registered_name', id: null },
        changes: { pattern: { new: item.pattern } },
      };
    case 'attachment':
      return {
        action: 'source.attach',
        target: { type: 'source', id: null },
        changes: { position: { new: item.precedence } },
      };
    case 'grant':
      return {
        action: item.scope === 'project' ? 'project_grant.create' : 'grant.create',
        target,
        changes: { subject_kind: { new: item.subject.type } },
      };
    case 'version_override':
      return {
        action: 'version.published_at_set',
        target: { type: 'version', id: null },
        changes: {
          package_name: { new: item.package },
          version: { new: item.version },
          published_at: { new: item.published_at },
          published_at_basis: { new: item.basis },
        },
      };
  }
}

export async function runImportApply(
  deps: ImportApplyDeps,
  ctx: OrgContext,
  payload: ImportRunJobPayload,
  fences: DelegatedFenceIssuer,
): Promise<ImportApplyResult> {
  const { store } = deps;
  const run = await store.loadRun(ctx, payload.runId);
  if (
    run === null ||
    run.id !== payload.runId ||
    run.state !== 'applying' ||
    run.approvedByUserId === null ||
    !validImportApprovalTimestamp(run.approvedAt, deps.clock.now().getTime())
  ) {
    return { status: 'not_approved' };
  }
  const approver = run.approvedByUserId;
  let lastFence: DelegatedMutationFence | undefined;
  const finish = async (outcome: 'applied' | { failed: ImportApplyFailure }) => {
    await store.finish(ctx, lastFence ?? fences(approver, run.id, {}), {
      runId: run.id,
      outcome,
      now: deps.clock.now().toISOString(),
    });
  };
  const fail = async (reason: ImportApplyFailure): Promise<ImportApplyResult> => {
    await finish({ failed: reason });
    return { status: 'failed', reason };
  };
  const manifest = await readManifest(deps, ctx, run.manifestBlobSha256);
  if (manifest === null) return fail('manifest_unavailable');
  if ((await planHash(manifest)) !== run.planHash) return fail('plan_hash_mismatch');
  const applied = new Set(await store.appliedRefs(ctx, run.id));
  const pending = [...manifest.items]
    .sort((a, b) => ORDER[a.type] - ORDER[b.type])
    .filter((item) => !applied.has(`${item.type}:${item.external_ref}`));
  const roles = new Map(
    manifest.items
      .filter((item) => item.type === 'role')
      .map((item) => [item.external_ref, item.permissions]),
  );
  const widening = new Set(manifest.widening.map((entry) => entry.external_ref));

  for (let offset = 0; offset < pending.length; offset += 50) {
    const items = pending.slice(offset, offset + 50);
    for (const item of items) {
      if (item.type !== 'grant') continue;
      const permissions =
        'ref' in item.role
          ? roles.get(item.role.ref)
          : await store.rolePermissions(ctx, item.role.existing);
      if (permissions == null) return fail('conflict');
      if (
        permissions.some((permission) => SESSION_ONLY.has(permission)) &&
        !widening.has(item.external_ref)
      )
        return fail('widening_refused');
    }
    const now = deps.clock.now().toISOString();
    const audits: AuditEvent[] = [];
    for (const item of items) {
      const audit = auditEvent({
        id: deps.ids.ulid(),
        now,
        ...itemAudit(item),
        actor: { type: 'user', id: approver },
        projectId: null,
        context: { opId: run.id, requestId: run.id, sourceIp: null, tokenSelector: null },
      });
      if (!audit.ok) return fail('conflict');
      audits.push(audit.event);
    }
    // No entity revisions are read by this job; reference resolution is inside applyChunk.
    lastFence = fences(approver, run.id, {});
    const result = await store.applyChunk(ctx, lastFence, {
      runId: run.id,
      items: items.map(applyItem),
      audits,
      auditProjects: items.map(auditProject),
      widening: [...widening],
      now,
    });
    if (!result.ok) return fail(result.reason === 'guard' ? 'guard_failed' : 'conflict');
  }
  await finish('applied');
  return { status: 'applied' };
}
