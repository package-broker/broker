import { afterEach, expect, it, vi } from 'vitest';
import { seedAuditList, type AuditFixtureRequest } from './audit-list-fixture.js';

const projectId = '01J00000000000000000000001';
const event = { action: 'project.create', targetId: projectId, projectId };
const status = { trailActive: true, pendingCount: 0, headSeq: 2 };
const created = { status: 201, data: { id: projectId } };

afterEach(() => vi.useRealTimers());

function requester(responses: { status: number; data: unknown }[]) {
  return vi.fn<AuditFixtureRequest>(async () => {
    const response = responses.shift();
    if (!response) throw new Error('unexpected fixture request');
    return response;
  });
}

it('creates a project over HTTP and waits for its sealed event, excluding unrelated or withheld rows', async () => {
  vi.useFakeTimers();
  const request = requester([
    created,
    { status: 200, data: { ...status, pendingCount: 1 } },
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
    { status: 200, data: status },
    { status: 200, data: { items: [event] } },
  ]);
  const prepared = seedAuditList(request);
  await vi.advanceTimersByTimeAsync(1999);
  expect(request).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(1);
  await prepared;
  expect(request.mock.calls).toEqual([
    [
      '/_pb/projects',
      {
        method: 'POST',
        body: { slug: expect.stringMatching(/^browser-audit-/), name: 'Browser audit fixture' },
        idempotencyKey: expect.any(String),
      },
    ],
    ['/_pb/audit/status'],
    ['/_pb/audit/status'],
    [`/_pb/audit?action=project.create&project=${projectId}`],
    ['/_pb/audit/status'],
    [`/_pb/audit?action=project.create&project=${projectId}`],
  ]);
});

it.each([
  [400, {}],
  [201, {}],
  [201, { id: null }],
])('refuses an unsuccessful or malformed project response (%s, %j)', async (status, data) => {
  const request = requester([{ status, data }]);
  await expect(seedAuditList(request)).rejects.toThrow('could not prepare a sealed project event');
  expect(request).toHaveBeenCalledTimes(1);
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
  await expect(seedAuditList(requester([created, ...responses]))).rejects.toThrow(
    'could not prepare a sealed project event',
  );
});

it('times out when the sealer never drains pending events', async () => {
  vi.useFakeTimers();
  const request = vi.fn<AuditFixtureRequest>(async (path) =>
    path === '/_pb/projects' ? created : { status: 200, data: { ...status, pendingCount: 1 } },
  );
  const failure = expect(seedAuditList(request)).rejects.toThrow(
    'timed out waiting for a sealed project event',
  );
  await vi.advanceTimersByTimeAsync(75_000);
  await failure;
  expect(request).toHaveBeenCalledTimes(76);
  expect(request.mock.calls.some(([path]) => path.startsWith('/_pb/audit?'))).toBe(false);
});

it('does not treat an empty journal head as a sealed project event', async () => {
  vi.useFakeTimers();
  const request = vi.fn<AuditFixtureRequest>(async (path) =>
    path === '/_pb/projects' ? created : { status: 200, data: { ...status, headSeq: 0 } },
  );
  const failure = expect(seedAuditList(request)).rejects.toThrow('timed out waiting');
  await vi.advanceTimersByTimeAsync(75_000);
  await failure;
  expect(request.mock.calls.some(([path]) => path.startsWith('/_pb/audit?'))).toBe(false);
});

it('replaces transport errors without retaining sensitive messages or causes', async () => {
  const request: AuditFixtureRequest = async () => {
    throw new Error('secret-cookie-canary');
  };
  const error = await seedAuditList(request).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toBe('Error: Audit list fixture could not prepare a sealed project event');
  expect((error as Error).cause).toBeUndefined();
});

it('times out when a drained journal never exposes the created project event', async () => {
  vi.useFakeTimers();
  const request = vi.fn<AuditFixtureRequest>(async (path) => {
    if (path === '/_pb/projects') return created;
    if (path === '/_pb/audit/status') return { status: 200, data: status };
    return { status: 200, data: { items: [] } };
  });
  const failure = expect(seedAuditList(request)).rejects.toThrow('timed out waiting');
  await vi.advanceTimersByTimeAsync(75_000);
  await failure;
  expect(request.mock.calls.filter(([path]) => path.startsWith('/_pb/audit?'))).toHaveLength(75);
});
