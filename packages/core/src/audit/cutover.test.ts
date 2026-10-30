import { expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { registerAuditExport, type VerifiedAuditArtifact } from './cutover.js';

const org = orgContext('01ARZ3NDEKTSV4RRFFQ69G5FAV');
const artifact: VerifiedAuditArtifact = {
  orgId: org.orgId,
  chainId: 'a'.repeat(32),
  epoch: 2,
  boundarySeq: 3,
  boundaryPrevHash: 'b'.repeat(64),
  headSeq: 4,
  headHash: 'c'.repeat(64),
  bodies: 2,
  withheld: 0,
};
const actor = { type: 'user', id: '01ARZ3NDEKTSV4RRFFQ69G5FAW' } as const;
const now = '2026-10-30T12:00:00.000Z';
it('records exactly the verified suffix and propagates a lost head check', async () => {
  const record = vi.fn(async () => false);
  expect(await registerAuditExport({ record }, org, artifact, 2, actor, now)).toBe(false);
  expect(record).toHaveBeenCalledWith(
    org,
    artifact,
    2,
    expect.objectContaining({ action: 'audit.export', actor }),
    expect.objectContaining({
      kind: 'export',
      reasonCode: 'verified_export',
      sinkId: null,
      fromSeq: 3,
      toSeq: 4,
      count: 2,
      chainId: artifact.chainId,
      epoch: 2,
    }),
  );
});
it.each([
  { orgId: null },
  { bodies: 1 },
  { withheld: 1 },
  { headSeq: 0 },
  { epoch: -1 },
  { headHash: 'secret@example.test' },
])('rejects invalid coverage before the database write: %j', async (change) => {
  const record = vi.fn();
  await expect(
    registerAuditExport({ record }, org, { ...artifact, ...change }, 0, actor, now),
  ).rejects.toThrow('Invalid verified audit export');
  expect(record).not.toHaveBeenCalled();
});
