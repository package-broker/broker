import type { BlobLifecycle, PurgeGeneration, Sha256 } from './blob.js';
import { canonicalPayload, defineJob, JobError } from './jobs.js';

type Removal = Pick<BlobLifecycle, 'recheckAndRemove' | 'markDeleted'>;
interface Payload {
  readonly sha256: Sha256;
  readonly generation: PurgeGeneration;
}
function validate(input: unknown): Payload {
  const payload = JSON.parse(canonicalPayload(input)) as Partial<Payload> | null;
  if (
    !payload ||
    Object.keys(payload).length !== 2 ||
    typeof payload.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(payload.sha256) ||
    typeof payload.generation !== 'string' ||
    !/^[0-9a-f]{32}$/.test(payload.generation)
  )
    throw new JobError('invalid_payload');
  return { sha256: payload.sha256, generation: payload.generation };
}
/** Bind a lifecycle with createBlobRemoveJob before dispatching jobs. */
export const blobRemoveJob = defineJob<unknown>({
  name: 'blob-remove',
  version: 1,
  validate,
  async handler(_payload, context) {
    if (context.signal.aborted) return;
    throw new JobError('invalid_definition');
  },
});
export function createBlobRemoveJob(lifecycle: Removal) {
  return defineJob<unknown>({
    ...blobRemoveJob,
    validate,
    async handler(input, context) {
      if (context.signal.aborted) return;
      const { sha256, generation } = validate(input);
      if (await lifecycle.recheckAndRemove(context.org, sha256, generation)) {
        await lifecycle.markDeleted(context.org, sha256, generation);
      }
    },
  });
}
