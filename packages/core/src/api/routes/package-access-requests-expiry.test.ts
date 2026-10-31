import { expect, it, vi } from 'vitest';
import { orgContext } from '../../db/port.js';
import type { PackageAccessRequestRepository } from '../../db/publishes.js';
import { jobFences } from '../../platform/job-fences.js';
import { fixedClock, ulid } from '../../ids.js';
import type { JobContext } from '../../platform/jobs.js';
import { createPackageAccessExpiryJob } from './package-access-requests-expiry.js';
function fixture() {
  const unused = async (): Promise<never> => {
    throw new Error('not_implemented');
  };
  const repository: PackageAccessRequestRepository = {
    requestable: unused,
    due: unused,
    get: unused,
    list: unused,
    request: unused,
    decide: unused,
  };
  const due = vi.fn(repository.due).mockResolvedValue([]);
  const decide = vi.fn(repository.decide).mockResolvedValue({ changed: true, revision: 2 });
  const def = createPackageAccessExpiryJob({ ...repository, due, decide });
  const enqueue = vi.fn().mockResolvedValue({ id: ulid(), created: true });
  const context = {
    org: orgContext('org'),
    jobId: ulid(),
    fence: 1,
    fences: jobFences({ id: 'J', owner: 'O', fence: 1 }),
    signal: new AbortController().signal,
    ports: {
      platform: { jobs: { enqueue } },
      clock: fixedClock('2026-10-30T00:00:00.000Z'),
      ids: { ulid },
    },
  } as unknown as JobContext;
  return { due, decide, def, context, enqueue };
}
it('schedules expiry hourly and refuses nonempty payloads', () => {
  const f = fixture();
  expect(f.def.schedule).toEqual({ everySeconds: 3600 });
  expect(() => f.def.validate({ extra: true })).toThrow('invalid_payload');
});
it('expires due rows with a leased system fence and one prepared audit per request', async () => {
  const f = fixture();
  f.due.mockResolvedValue([
    { id: ulid(), packageId: ulid(), packageName: 'widget', projectId: ulid(), revision: 3 },
  ] as never);
  await f.def.handler({}, f.context);
  expect(f.decide).toHaveBeenCalledWith(
    f.context.org,
    expect.objectContaining({ writer: 'purge', job: { id: 'J', owner: 'O', fence: 1 } }),
    expect.objectContaining({
      state: 'expired',
      expectedRevision: 3,
      decidedByUserId: null,
      event: expect.objectContaining({
        action: 'package.access_decide',
        actor: { type: 'system', id: 'package-access-expire' },
      }),
    }),
  );
  expect(JSON.parse(f.decide.mock.calls[0]![2].event.payloadJson)).toMatchObject({
    changes: { package: { new: 'widget' } },
  });
});
it('refuses an unleased execution and stops on cancellation', async () => {
  const f = fixture();
  await expect(
    f.def.handler({}, { ...f.context, fences: undefined } as unknown as JobContext),
  ).rejects.toThrow('lease_lost');
  const controller = new AbortController();
  controller.abort();
  await f.def.handler({}, { ...f.context, signal: controller.signal });
  expect(f.due).not.toHaveBeenCalled();
  expect(f.decide).not.toHaveBeenCalled();
});
it('continues after ten rows in a new job and stops after a race', async () => {
  const f = fixture();
  const item = {
    id: ulid(),
    packageId: ulid(),
    packageName: 'widget',
    projectId: ulid(),
    revision: 1,
  };
  f.due
    .mockResolvedValueOnce(Array.from({ length: 10 }, () => item) as never)
    .mockResolvedValueOnce([item] as never)
    .mockResolvedValueOnce([]);
  await f.def.handler({}, f.context);
  expect(f.decide).toHaveBeenCalledTimes(10);
  expect(f.enqueue).toHaveBeenCalledOnce();
  await f.def.handler({}, f.context);
  expect(f.decide).toHaveBeenCalledTimes(11);
  f.enqueue.mockClear();
  f.due
    .mockReset()
    .mockResolvedValueOnce(Array.from({ length: 10 }, () => item) as never)
    .mockRejectedValue(new Error('Repeated unchanged batch'));
  f.decide.mockClear().mockResolvedValue({ changed: false, revision: 2 });
  await f.def.handler({}, f.context);
  expect(f.due).toHaveBeenCalledTimes(1);
  expect(f.decide).toHaveBeenCalledTimes(10);
  expect(f.enqueue).not.toHaveBeenCalled();
});
