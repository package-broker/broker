import type { ImportApplyStore } from '@package-broker/core/import/apply';
import { importApplyJob, importRollbackJob } from '@package-broker/core/import/jobs';
import type { ImportRollbackStore } from '@package-broker/core/import/rollback';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { RegisteredCoreJob } from '@package-broker/core/kernel/registry';
import type { BlobStore } from '@package-broker/core/platform/blob';
import { JobError, type JobDefinition } from '@package-broker/core/platform/jobs';
import { registerCoreJob } from '@package-broker/core/runtime/core-jobs';

export interface ImportJobStores {
  readonly applyStore: ImportApplyStore;
  readonly rollbackStore: ImportRollbackStore;
  readonly blobs: Pick<BlobStore, 'get'>;
}

export interface ImportJobHolder {
  set(stores: ImportJobStores): void;
  get(): ImportJobStores;
}

export function createImportJobHolder(): ImportJobHolder {
  let current: ImportJobStores | undefined;
  return {
    set(stores) {
      if (current !== undefined) throw new Error('import job stores are already set');
      current = stores;
    },
    get() {
      if (current === undefined) throw new JobError('handler_error');
      return current;
    },
  };
}

function erased<P>(definition: JobDefinition<P>): JobDefinition {
  return {
    ...definition,
    handler: (payload, context) => definition.handler(definition.validate(payload), context),
  };
}

export function importJobRegistrations(holder: ImportJobHolder): readonly RegisteredCoreJob[] {
  return [
    registerCoreJob(
      erased(
        importApplyJob({
          get store() {
            return holder.get().applyStore;
          },
          get blobs() {
            return holder.get().blobs;
          },
          clock: systemClock,
          ids: { ulid },
        }),
      ),
    ),
    registerCoreJob(
      erased(
        importRollbackJob({
          get store() {
            return holder.get().rollbackStore;
          },
          clock: systemClock,
          ids: { ulid },
        }),
      ),
    ),
  ];
}
