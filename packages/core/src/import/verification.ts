import type { FencedOutcome, SystemMutationFence } from '../authz/fence.js';
import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import type { BlobStore } from '../platform/blob.js';
import { JobError } from '../platform/jobs.js';
import { readImportManifest, type ImportApplyRun } from './apply.js';
import { planHash, type Manifest } from './manifest.js';
import type { ImportRunJobPayload } from './run-service.js';

export type ImportVerificationFailure =
  | 'manifest_unavailable'
  | 'plan_hash_mismatch'
  | 'item_missing'
  | 'digest_mismatch'
  | 'visibility_mismatch'
  | 'credential_missing';

/**
 * All reads and writes are organization scoped. verify checks exactly one live, unrolled journal
 * entry per manifest item, its recorded digest and visibility, including linked parent rows.
 * A declared credential must be bound in the same organization and project. Source credentials
 * are checked separately from the pre-upload digest. Completion rechecks the mutation epoch,
 * run and verifier lease in the same batch as its audit. Failure returns verifying to applied;
 * success sets the immutable 90-day expiry. A refused lease writes neither outcome nor audit.
 */
export interface ImportVerificationStore {
  loadRun(ctx: OrgContext, runId: string): Promise<ImportApplyRun | null>;
  verify(
    ctx: OrgContext,
    fence: SystemMutationFence,
    input: { readonly runId: string; readonly manifest: Manifest; readonly now: string },
  ): Promise<FencedOutcome>;
  fail(
    ctx: OrgContext,
    fence: SystemMutationFence,
    input: {
      readonly runId: string;
      readonly reason: ImportVerificationFailure;
      readonly now: string;
    },
  ): Promise<FencedOutcome>;
}

export interface ImportVerificationDeps {
  readonly store: ImportVerificationStore;
  readonly blobs: Pick<BlobStore, 'get'>;
  readonly clock: Clock;
}

export async function runImportVerification(
  deps: ImportVerificationDeps,
  ctx: OrgContext,
  payload: ImportRunJobPayload,
  issueFence: () => SystemMutationFence,
): Promise<void> {
  const run = await deps.store.loadRun(ctx, payload.runId);
  if (run === null || run.id !== payload.runId || run.state !== 'verifying') return;
  const manifest = await readImportManifest(deps, ctx, run.manifestBlobSha256, {
    retryReadErrors: true,
  });
  const reason =
    manifest === null
      ? 'manifest_unavailable'
      : (await planHash(manifest)) !== run.planHash
        ? 'plan_hash_mismatch'
        : null;
  const fence = issueFence();
  const now = deps.clock.now().toISOString();
  const result =
    reason !== null || manifest === null
      ? await deps.store.fail(ctx, fence, {
          runId: run.id,
          reason: reason ?? 'manifest_unavailable',
          now,
        })
      : await deps.store.verify(ctx, fence, { runId: run.id, manifest, now });
  if (!result.ok) throw new JobError('handler_error');
}
