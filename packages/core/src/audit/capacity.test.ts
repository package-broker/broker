import { expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { auditCapacityReserveBytes, evictAudit } from './capacity.js';

const ctx = orgContext('org');
const options = { generation: 1, maxJournalBytes: 64 * 1024 * 1024 };

it('reserves one percent within the journal budget', () => {
  expect(auditCapacityReserveBytes(100)).toBe(1);
  expect(auditCapacityReserveBytes(101)).toBe(2);
  expect(auditCapacityReserveBytes(options.maxJournalBytes)).toBe(671089);
});
it.each([
  { maxJournalBytes: 0 },
  { maxJournalBytes: -1 },
  { maxJournalBytes: NaN },
  { maxJournalBytes: Infinity },
  { maxJournalBytes: 1.5 },
  { maxJournalBytes: Number.MAX_SAFE_INTEGER + 1 },
  { generation: -1 },
  { generation: NaN },
  { limit: 0 },
  { limit: 501 },
  { limit: 1.5 },
])('rejects invalid options before storage: %j', async (change) => {
  const evict = vi.fn();
  await expect(evictAudit({ evict }, ctx, { ...options, ...change })).rejects.toThrow(TypeError);
  expect(evict).not.toHaveBeenCalled();
});
it('delegates one bounded eviction', async () => {
  const result = { outcome: 'evicted', evicted: 2, boundarySeq: 3 };
  const evict = vi.fn().mockResolvedValue(result);
  expect(await evictAudit({ evict }, ctx, options)).toEqual(result);
  expect(evict).toHaveBeenCalledExactlyOnceWith(ctx, options);
});
