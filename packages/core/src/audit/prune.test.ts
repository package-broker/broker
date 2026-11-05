import { expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { pruneAudit } from './prune.js';
const ctx = orgContext('org');
const options = { generation: 1, configuredSinkIds: ['archive'], trailActive: false };
it('does not ask the database to prune while the trail is active', async () => {
  const prune = vi.fn();
  expect(await pruneAudit({ prune }, ctx, { ...options, trailActive: true })).toEqual({
    outcome: 'retained',
  });
  expect(prune).not.toHaveBeenCalled();
});
it.each([
  { limit: 0 },
  { limit: 501 },
  { limit: 1.5 },
  { generation: -1 },
  { generation: NaN },
  { configuredSinkIds: ['invalid/id'] },
])('rejects invalid bounds and generation before accessing storage: %j', async (change) => {
  const prune = vi.fn();
  await expect(pruneAudit({ prune }, ctx, { ...options, ...change })).rejects.toThrow(
    'Invalid audit prune options',
  );
  expect(prune).not.toHaveBeenCalled();
});
it('delegates one bounded invocation', async () => {
  const prune = vi.fn().mockResolvedValue({ outcome: 'pruned', pruned: 2, boundarySeq: 3 });
  expect(await pruneAudit({ prune }, ctx, options)).toEqual({
    outcome: 'pruned',
    pruned: 2,
    boundarySeq: 3,
  });
  expect(prune).toHaveBeenCalledExactlyOnceWith(ctx, options);
});
