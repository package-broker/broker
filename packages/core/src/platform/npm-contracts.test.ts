import { describe, expect, expectTypeOf, it } from 'vitest';
import { orgContext } from '../db/port.js';
import type {
  CatalogueWriter,
  PublishVersionInput,
  PublishVersionResult,
} from '../db/catalogue.js';
import { fixedClock } from '../ids.js';
import {
  BlobValidationError,
  createBlobStore,
  createBlobUploadAdmission,
  type BlobMetadataPort,
  type ByteStore,
  type CoreBlobStore as BlobStore,
  type StagedBlob,
} from './blob.js';
import { createRepositoryJobs } from './jobs-port.js';
import type { CoreJobs as Jobs } from './jobs.js';
import type { PlatformPorts } from '../plugin.js';
import type { PublishApprovalInsert } from '../db/publishes.js';

const ctx = orgContext('organization');

describe('npm platform contracts', () => {
  it('pins the required staged port and publish method names', () => {
    expectTypeOf<Pick<BlobStore, 'stage' | 'openStaged' | 'promote' | 'discard'>>().toBeObject();
    expectTypeOf<
      Pick<ByteStore, 'putStaged' | 'openStaged' | 'promote' | 'discardStaged' | 'listStaged'>
    >().toBeObject();
    expectTypeOf<
      Parameters<CatalogueWriter['publishVersion']>[2]
    >().toEqualTypeOf<PublishVersionInput>();
    expectTypeOf<ReturnType<CatalogueWriter['publishVersion']>>().toEqualTypeOf<
      Promise<PublishVersionResult>
    >();
    expectTypeOf<Parameters<Jobs['enqueueStatements']>[0]>().toEqualTypeOf<typeof ctx>();
  });

  it('keeps kernel capabilities off plugin ports and preserves media type and insert inputs', () => {
    expectTypeOf<
      Extract<keyof PlatformPorts['blob'], 'stage' | 'openStaged' | 'promote' | 'discard'>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof PlatformPorts['jobs'], 'enqueueStatements'>
    >().toEqualTypeOf<never>();
    expectTypeOf<StagedBlob['mediaType']>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<BlobStore['stage']>[2]['mediaType']>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<ByteStore['putStaged']>[3]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<ByteStore['promote']>[3]>().toEqualTypeOf<string>();
    expectTypeOf<
      Extract<
        keyof PublishApprovalInsert,
        | 'revision'
        | 'createdAt'
        | 'updatedAt'
        | 'scanAttempts'
        | 'decidedByUserId'
        | 'decidedAt'
        | 'decisionReason'
      >
    >().toEqualTypeOf<never>();
    expectTypeOf<PublishVersionInput['approval']>().toEqualTypeOf<PublishApprovalInsert | null>();
  });

  it.each(['stage', 'openStaged', 'promote', 'discard'] as const)(
    'refuses invalid blob %s before storage access',
    async (method) => {
      const blob = createBlobStore({} as ByteStore, {} as BlobMetadataPort, {
        admission: createBlobUploadAdmission(),
      });
      const staged = {} as StagedBlob;
      const calls = {
        stage: () =>
          blob.stage(ctx, new ReadableStream(), { maxBytes: -1, mediaType: 'application/gzip' }),
        openStaged: () => blob.openStaged(ctx, staged),
        promote: () => blob.promote(ctx, staged, { refetchable: false }),
        discard: () => blob.discard(ctx, staged),
      };
      await expect(calls[method]()).rejects.toBeInstanceOf(BlobValidationError);
    },
  );

  it('refuses to build job statements until their atomic implementation exists', async () => {
    const factory = createRepositoryJobs({
      store: {
        enqueue: () => {
          throw new Error('unexpected');
        },
        status: () => Promise.resolve(null),
      },
      clock: fixedClock('2026-10-30T00:00:00.000Z'),
      ids: { ulid: () => 'id' },
      jobs: [],
    });
    const jobs = factory('core', { projectId: null, tokenId: null });
    await expect(
      jobs.enqueueStatements(
        ctx,
        'core:publish-scan:v1',
        {},
        { idempotencyKey: 'publish:version' },
      ),
    ).rejects.toThrow('not_implemented');
  });
});
