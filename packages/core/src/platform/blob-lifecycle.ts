import type { OrgContext } from '../db/port.js';
import {
  BlobValidationError,
  blobStorageKey,
  parseSha256,
  type BlobLifecycle,
  type ByteStore,
  type PurgeGeneration,
  type Sha256,
} from './blob.js';
import type { Observability } from './observability.js';

export interface BlobLifecycleMetadataPort {
  softDelete(ctx: OrgContext, key: Sha256, input: { removedAt: string }): Promise<boolean>;
  claimPurge(ctx: OrgContext, key: Sha256): Promise<PurgeGeneration | null>;
  canStartRemove(
    ctx: OrgContext,
    key: Sha256,
    generation: PurgeGeneration,
    deleteTimeoutMs: number,
  ): Promise<boolean>;
  markDeleted(ctx: OrgContext, key: Sha256, generation: PurgeGeneration): Promise<boolean>;
  cancelPurge(ctx: OrgContext, key: Sha256, generation: PurgeGeneration): Promise<boolean>;
  unschedule(ctx: OrgContext, key: Sha256): Promise<boolean>;
}

export interface BlobLifecycleOptions {
  readonly metadata: BlobLifecycleMetadataPort;
  readonly store: ByteStore;
  readonly deleteTimeoutMs: number;
  readonly leaseMs: number;
  readonly observability: Observability;
}

function validateGeneration(generation: PurgeGeneration): void {
  if (typeof generation !== 'string' || !/^[0-9a-f]{32}$/.test(generation)) {
    throw new BlobValidationError();
  }
}

export function createBlobLifecycle({
  metadata,
  store,
  deleteTimeoutMs,
  leaseMs,
  observability,
}: BlobLifecycleOptions): BlobLifecycle & Pick<BlobLifecycleMetadataPort, 'unschedule'> {
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) throw new TypeError('invalid leaseMs');
  if (
    !Number.isInteger(deleteTimeoutMs) ||
    deleteTimeoutMs < 1000 ||
    deleteTimeoutMs > leaseMs / 10
  ) {
    throw new TypeError('invalid deleteTimeoutMs');
  }

  return {
    async softDelete(ctx, key, input) {
      parseSha256(key);
      return metadata.softDelete(ctx, key, input);
    },
    async claimPurge(ctx, key) {
      parseSha256(key);
      return metadata.claimPurge(ctx, key);
    },
    async markDeleted(ctx, key, generation) {
      parseSha256(key);
      validateGeneration(generation);
      return metadata.markDeleted(ctx, key, generation);
    },
    async cancelPurge(ctx, key, generation) {
      parseSha256(key);
      validateGeneration(generation);
      return metadata.cancelPurge(ctx, key, generation);
    },
    async unschedule(ctx, key) {
      parseSha256(key);
      return metadata.unschedule(ctx, key);
    },
    async recheckAndRemove(ctx, key, generation) {
      parseSha256(key);
      validateGeneration(generation);
      if (!(await metadata.canStartRemove(ctx, key, generation, 2 * deleteTimeoutMs))) {
        observability.counter('pb.blob.purge', { outcome: 'refused' });
        return false;
      }

      const storageKey = blobStorageKey(ctx.orgId, key);
      const startedAt = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let outcome: 'removed' | 'timeout' | 'error';
      try {
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), deleteTimeoutMs);
        });
        // Promise.race also handles a removal rejection arriving after the timeout.
        outcome = await Promise.race([
          store.remove(storageKey).then(() => 'removed' as const),
          timeout,
        ]);
      } catch {
        outcome = 'error';
      } finally {
        clearTimeout(timer);
      }
      observability.counter('pb.blob.purge', { outcome });
      observability.histogram('pb.blob.purge_remove_ms', performance.now() - startedAt);
      return outcome === 'removed';
    },
  };
}
