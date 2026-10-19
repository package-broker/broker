import { expect, it, vi } from 'vitest';
import { registerCoreJob } from '../runtime/core-jobs.js';
import { blobRemoveJob, createBlobRemoveJob } from './blob-remove-job.js';
import { defineJob, JobError, type JobContext, MAX_PAYLOAD_BYTES } from './jobs.js';

const payload = { sha256: 'b'.repeat(64), generation: 'c'.repeat(32) };
it.each([
  { ...payload, sha256: 'b'.repeat(63) },
  { ...payload, sha256: 'B'.repeat(64) },
  { sha256: payload.sha256 },
  { ...payload, extra: true },
  { ...payload, generation: 'c'.repeat(33) },
  { ...payload, generation: 'C'.repeat(32) },
  { ...payload, generation: 'c'.repeat(31) },
  { ...payload, sha256: 'b'.repeat(MAX_PAYLOAD_BYTES + 1) },
])('rejects invalid removal payload %# without invoking handler', (invalid) => {
  const lifecycle = { recheckAndRemove: vi.fn(), markDeleted: vi.fn() };
  const job = createBlobRemoveJob(lifecycle);
  expect(() => job.validate(invalid)).toThrow(JobError);
  expect(() => job.validate(invalid)).toThrow(/invalid_payload|payload_too_large/);
  expect(lifecycle.recheckAndRemove).not.toHaveBeenCalled();
  expect(lifecycle.markDeleted).not.toHaveBeenCalled();
});
it('exports a version one definition factory', () => {
  const job = createBlobRemoveJob({ recheckAndRemove: vi.fn(), markDeleted: vi.fn() });
  expect([job.name, job.version, job.validate(payload)]).toEqual(['blob-remove', 1, payload]);
  expect(registerCoreJob(job).qualifiedName).toBe('core:blob-remove:v1');
});
it('exports a registerable version one definition', () => {
  expect(() => defineJob(blobRemoveJob)).not.toThrow();
  expect([blobRemoveJob.name, blobRemoveJob.version, blobRemoveJob.validate(payload)]).toEqual([
    'blob-remove',
    1,
    payload,
  ]);
  expect(blobRemoveJob.handler).toBeTypeOf('function');
  expect(registerCoreJob(blobRemoveJob).qualifiedName).toBe('core:blob-remove:v1');
});
it('requires lifecycle binding before executing the exported definition', async () => {
  const controller = new AbortController();
  const context = { signal: controller.signal } as JobContext;
  await expect(blobRemoveJob.handler(blobRemoveJob.validate(payload), context)).rejects.toThrow(
    'invalid_definition',
  );
  controller.abort();
  await expect(
    blobRemoveJob.handler(blobRemoveJob.validate(payload), context),
  ).resolves.toBeUndefined();
});
