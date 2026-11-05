import { afterEach, expect, it, vi } from 'vitest';
import { seedAuditList, type AuditFixtureRequest } from './audit-list-fixture.js';

const projectId = '01J00000000000000000000001';
const event = { action: 'project.create', targetId: projectId, projectId };
const status = { trailActive: true, pendingCount: 42, headSeq: 2 };
const created = { status: 201, data: { id: projectId } };
afterEach(() => vi.useRealTimers());
function requester(responses: { status: number; data: unknown }[]) {
  return vi.fn<AuditFixtureRequest>(async () => {
    const response = responses.shift();
    if (!response) throw new Error('unexpected fixture request');
    return response;
  });
}
it('drives sealing once and waits only for its own event despite unrelated pending work', async () => {
  vi.useFakeTimers();
  const request = requester([
    created,
    { status: 200, data: status },
    {
      status: 200,
      data: {
        items: [
          { ...event, targetId: 'other' },
          { ...event, projectId: 'other' },
          { ...event, action: 'project.update' },
          { ...event, kind: 'withheld', seq: 1 },
        ],
      },
    },
    { status: 200, data: { items: [event] } },
  ]);
  const seal = vi.fn(async () => {
    expect(request).toHaveBeenCalledTimes(2);
  });
  const prepared = seedAuditList(request, seal);
  await vi.advanceTimersByTimeAsync(1000);
  await prepared;
  expect(seal).toHaveBeenCalledOnce();
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    '/_pb/projects',
    '/_pb/audit/status',
    `/_pb/audit?action=project.create&project=${projectId}`,
    `/_pb/audit?action=project.create&project=${projectId}`,
  ]);
});
it.each([
  [400, {}],
  [201, {}],
  [201, { id: null }],
])('refuses malformed creation (%s)', async (code, data) => {
  const seal = vi.fn(async () => {});
  await expect(seedAuditList(requester([{ status: code, data }]), seal)).rejects.toThrow(
    'could not prepare',
  );
  expect(seal).not.toHaveBeenCalled();
});
it.each([
  [{ status: 403, data: {} }],
  [{ status: 200, data: { ...status, trailActive: false } }],
  [{ status: 200, data: null }],
  [
    { status: 200, data: status },
    { status: 500, data: {} },
  ],
  [
    { status: 200, data: status },
    { status: 200, data: { items: null } },
  ],
])('refuses unavailable audit status or lists (%j)', async (...responses) => {
  await expect(seedAuditList(requester([created, ...responses]), async () => {})).rejects.toThrow(
    'could not prepare',
  );
});
it('times out on its own missing event even with a populated head', async () => {
  vi.useFakeTimers();
  const request = vi.fn<AuditFixtureRequest>(async (path) => {
    if (path === '/_pb/projects') return created;
    if (path === '/_pb/audit/status') return { status: 200, data: status };
    return { status: 200, data: { items: [] } };
  });
  const seal = vi.fn(async () => {});
  const failure = expect(seedAuditList(request, seal)).rejects.toThrow('timed out waiting');
  await vi.advanceTimersByTimeAsync(10_000);
  await failure;
  expect(seal).toHaveBeenCalledOnce();
  expect(request.mock.calls.filter(([path]) => path.startsWith('/_pb/audit?'))).toHaveLength(10);
});
it.each(['request', 'seal'])('redacts %s failures', async (source) => {
  const fail = async (): Promise<never> => {
    throw new Error('secret-cookie-canary');
  };
  const request = source === 'request' ? fail : requester([created, { status: 200, data: status }]);
  const error = await seedAuditList(request, source === 'seal' ? fail : async () => {}).catch(
    (error: unknown) => error,
  );
  expect(String(error)).toBe('Error: Audit list fixture could not prepare a sealed project event');
  expect((error as Error).cause).toBeUndefined();
});
