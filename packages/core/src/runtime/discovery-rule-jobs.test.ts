import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import type {
  DiscoveryRule,
  DiscoveryRuleRepository,
  DiscoveryRuleState,
} from '../db/discovery-rules.js';
import type { JobContext } from '../platform/jobs.js';
import { jobFences } from '../platform/job-fences.js';
import { ulid } from '../ids.js';
import { discoveryRuleJobs } from './discovery-rule-jobs.js';

const id = '01JA0000000000000000000011';
const now = '2026-11-04T12:00:00.000Z';
function fixture() {
  let instant = new Date(now);
  let rule: DiscoveryRule = {
    id,
    name: 'Libraries',
    credentialId: '01JA0000000000000000000012',
    installationId: 41,
    ecosystem: 'both',
    pattern: '*',
    includeForks: false,
    enabled: true,
    intervalSeconds: 86400,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    outcome: null,
    created: 0,
    existing: 0,
    skipped: 0,
    failed: 0,
    skips: [],
    cursor: null,
    remaining: [],
    nextRunAt: null,
  };
  const checkpoint = vi.fn(async (_ctx, _fence, state: DiscoveryRuleState) => {
    rule = { ...rule, ...state };
    return true;
  });
  const rules = {
    get: vi.fn(async () => rule),
    due: vi.fn(async () => [rule]),
    checkpoint,
  } as unknown as DiscoveryRuleRepository;
  const dryRun = vi.fn(async () => ({
    ok: true,
    value: {
      entries: [
        {
          repository: 'acme/library',
          action: 'new',
          ecosystem: 'npm',
          packageName: 'library',
          reason: null,
        },
      ],
      nextCursor: '2',
    },
  }));
  const apply = vi.fn(async () => ({
    ok: true,
    value: {
      created: 1,
      existing: 0,
      skipped: 0,
      failed: 0,
      results: [{ repository: 'acme/library', outcome: 'created' }],
      remainingRepositories: [],
      nextCursor: '2',
    },
  }));
  const enqueue = vi.fn(async () => ({ id: 'queued', created: true }));
  const context = {
    org: orgContext('org'),
    jobId: 'job',
    attempt: 1,
    fence: 3,
    idempotencyKey: 'run',
    signal: new AbortController().signal,
    fences: jobFences({ id: 'job', owner: 'worker', fence: 3 }),
    ports: { platform: { jobs: { enqueue } } },
  } as unknown as JobContext;
  const budgetSpent = vi.fn(() => false);
  const jobs = discoveryRuleJobs(() => ({
    rules,
    discovery: { dryRun, apply, budgetSpent } as never,
    clock: { now: () => instant },
    ids: { ulid },
  }));
  const run = () => jobs[1]!.definition.handler({ ruleId: id, revision: 1 }, context);
  return {
    jobs,
    budgetSpent,
    advance: () => {
      instant = new Date(instant.getTime() + 60000);
    },
    context,
    run,
    dryRun,
    apply,
    enqueue,
    checkpoint,
    rules,
    get rule() {
      return rule;
    },
    change: (change: Partial<DiscoveryRule>) => {
      rule = { ...rule, ...change };
    },
  };
}
describe('scheduled discovery rules', () => {
  it('registers a minute dispatcher and per-rule lease resources', async () => {
    const f = fixture();
    expect(f.jobs.map((j) => j.qualifiedName)).toEqual([
      'core:discovery-rules:v1',
      'core:discovery-rule:v1',
    ]);
    expect(f.jobs[0]!.definition.schedule).toEqual({ everySeconds: 60 });
    await f.jobs[0]!.definition.handler({}, f.context);
    expect(f.enqueue).toHaveBeenCalledWith(
      orgContext('org'),
      'core:discovery-rule:v1',
      { ruleId: id, revision: 1 },
      expect.objectContaining({ resourceKey: `discovery-rule:${id}` }),
    );
  });
  it('budgets one repository, checkpoints the next page and audits as the rule', async () => {
    const f = fixture();
    await f.run();
    expect(f.dryRun).toHaveBeenCalledTimes(1);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.rule).toMatchObject({ created: 1, cursor: '2', outcome: 'running', remaining: [] });
    const [, actor, fence, input, call] = f.apply.mock.calls[0] as unknown as [
      unknown,
      unknown,
      Record<string, unknown>,
      unknown,
      unknown,
    ];
    expect(actor).toEqual({ kind: 'rule', ruleId: id });
    expect(fence).not.toHaveProperty('userId');
    expect(input).toMatchObject({ repositories: ['acme/library'], nextCursor: '2' });
    expect(call).toHaveProperty('audit');
    for (const args of f.checkpoint.mock.calls.filter(
      (args) => ((args as unknown[])[3] as unknown[]).length > 0,
    ))
      expect((args as unknown[])[3]).toEqual(
        expect.arrayContaining([expect.objectContaining({ actor: { type: 'system', id } })]),
      );
  });
  it('retries a rate-limited repository first without replanning or losing its page cursor', async () => {
    const f = fixture();
    f.change({
      outcome: 'rate_limited',
      lastRunAt: now,
      cursor: '3',
      remaining: ['acme/limited', 'acme/next'],
      created: 4,
    });
    f.apply.mockResolvedValueOnce({
      ok: true,
      value: {
        created: 0,
        existing: 0,
        skipped: 0,
        failed: 1,
        results: [{ repository: 'acme/limited', outcome: 'failed', error: 'rate_limited' }],
        remainingRepositories: ['acme/limited', 'acme/next'],
        nextCursor: '3',
      },
    } as never);
    await f.run();
    expect(f.dryRun).not.toHaveBeenCalled();
    expect(f.rule).toMatchObject({
      remaining: ['acme/limited', 'acme/next'],
      cursor: '3',
      created: 4,
      outcome: 'rate_limited',
      nextRunAt: '2026-11-04T12:05:00.000Z',
    });
  });
  it('resumes pending work and finishes when both checkpoint components are empty', async () => {
    const f = fixture();
    f.change({ outcome: 'running', lastRunAt: now, remaining: ['acme/library'], created: 4 });
    await f.run();
    expect(f.dryRun).not.toHaveBeenCalled();
    expect(f.rule).toMatchObject({
      created: 5,
      remaining: [],
      cursor: null,
      outcome: 'succeeded',
      nextRunAt: '2026-11-05T12:00:00.000Z',
    });
  });
  it('counts existing and skipped plans and caps skip history', async () => {
    const f = fixture();
    f.change({
      outcome: 'running',
      lastRunAt: now,
      cursor: '1',
      skips: Array.from({ length: 50 }, (_, n) => ({ repository: `acme/r${n}`, reason: 'fork' })),
    });
    f.dryRun.mockResolvedValueOnce({
      ok: true,
      value: {
        entries: [
          {
            repository: 'acme/fork',
            action: 'skipped',
            reason: 'fork',
            ecosystem: null,
            packageName: null,
          },
          {
            repository: 'acme/old',
            action: 'existing',
            reason: null,
            ecosystem: 'npm',
            packageName: 'old',
          },
        ],
        nextCursor: null,
      },
    } as never);
    await f.run();
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.rule).toMatchObject({ skipped: 1, existing: 1, outcome: 'succeeded' });
    expect(f.rule.skips).toHaveLength(50);
  });
  for (const change of [
    { enabled: false },
    { revision: 2 },
    { nextRunAt: '2026-11-05T00:00:00.000Z' },
  ])
    it(`does not run a stale or disabled rule ${JSON.stringify(change)}`, async () => {
      const f = fixture();
      f.change(change);
      await f.run();
      expect(f.dryRun).not.toHaveBeenCalled();
      expect(f.apply).not.toHaveBeenCalled();
    });
  it('rejects a lost checkpoint lease without applying unauthorized work', async () => {
    const f = fixture();
    f.checkpoint.mockResolvedValueOnce(false);
    f.dryRun.mockResolvedValueOnce({ ok: false, error: 'forbidden' } as never);
    await expect(f.run()).rejects.toMatchObject({ code: 'lease_lost' });
    expect(f.apply).not.toHaveBeenCalled();
  });
});

it('resumes the next plan page on the next tick with cumulative results', async () => {
  const f = fixture();
  await f.run();
  expect(f.rule.nextRunAt).toBe('2026-11-04T12:01:00.000Z');
  f.advance();
  f.dryRun.mockResolvedValueOnce({ ok: true, value: { entries: [], nextCursor: null } } as never);
  await f.run();
  expect(f.dryRun).toHaveBeenLastCalledWith(
    orgContext('org'),
    { kind: 'rule', ruleId: id },
    expect.objectContaining({ cursor: '2' }),
    expect.objectContaining({ ruleId: id }),
  );
  expect(f.rule).toMatchObject({ created: 1, outcome: 'succeeded', cursor: null, remaining: [] });
});
it('honors GitHub backoff longer than the minimum delay', async () => {
  const f = fixture();
  f.dryRun.mockResolvedValueOnce({
    ok: false,
    error: 'rate_limited',
    retryAfterSeconds: 3600,
  } as never);
  await f.run();
  expect(f.rule).toMatchObject({
    outcome: 'rate_limited',
    cursor: '1',
    failed: 0,
    nextRunAt: '2026-11-04T13:00:00.000Z',
  });
  expect(f.apply).not.toHaveBeenCalled();
});

it('counts mixed ecosystem results once when a repository is replanned for apply', async () => {
  const f = fixture();
  f.dryRun.mockResolvedValueOnce({
    ok: true,
    value: {
      entries: [
        {
          repository: 'acme/library',
          ecosystem: 'composer',
          action: 'existing',
          packageName: 'acme/library',
          reason: null,
        },
        {
          repository: 'acme/library',
          ecosystem: 'npm',
          action: 'new',
          packageName: 'library',
          reason: null,
        },
      ],
      nextCursor: null,
    },
  } as never);
  f.apply.mockResolvedValueOnce({
    ok: true,
    value: {
      created: 1,
      existing: 1,
      skipped: 0,
      failed: 0,
      results: [
        { repository: 'acme/library', outcome: 'existing' },
        { repository: 'acme/library', outcome: 'created' },
      ],
      remainingRepositories: [],
      nextCursor: null,
    },
  } as never);
  await f.run();
  expect(f.rule).toMatchObject({ created: 1, existing: 1, outcome: 'succeeded' });
});

for (const error of ['upstream_status', 'invalid_response', 'timeout', 'busy', 'unknown'])
  it(`preserves progress and backs off a transient ${error}`, async () => {
    const f = fixture();
    f.change({ outcome: 'running', cursor: '3', created: 4 });
    f.dryRun.mockImplementationOnce(async () => {
      f.advance();
      f.advance();
      return { ok: false, error } as never;
    });
    await f.run();
    expect(f.rule).toMatchObject({
      outcome: 'running',
      cursor: '3',
      created: 4,
      nextRunAt: '2026-11-04T12:07:00.000Z',
    });
  });
it('uses the response clock and caps plan rate-limit backoff', async () => {
  const f = fixture();
  f.dryRun.mockImplementationOnce(async () => {
    f.advance();
    f.advance();
    return { ok: false, error: 'rate_limited', retryAfterSeconds: 99999 } as never;
  });
  await f.run();
  expect(f.rule.nextRunAt).toBe('2026-11-04T13:02:00.000Z');
});
it('processes several pending repositories in a tick', async () => {
  const f = fixture();
  f.change({ outcome: 'running', remaining: ['acme/a', 'acme/b', 'acme/c'] });
  await f.run();
  expect((f.apply.mock.calls[0] as unknown[] | undefined)?.[3]).toMatchObject({
    repositories: ['acme/a', 'acme/b', 'acme/c'],
  });
});
it('does not audit routine checkpoints', async () => {
  const f = fixture();
  f.change({ outcome: 'running', cursor: '2' });
  await f.run();
  expect(
    f.checkpoint.mock.calls.every((args) => ((args as unknown[])[3] as unknown[]).length === 0),
  ).toBe(true);
});

it('caps consecutive transient failures without discarding the checkpoint', async () => {
  const f = fixture();
  f.change({ outcome: 'running', cursor: '3', created: 4 });
  for (let n = 1; n <= 5; n++) {
    f.change({ nextRunAt: null });
    f.dryRun.mockResolvedValueOnce({ ok: false, error: 'invalid_response' } as never);
    await f.run();
    expect(f.rule).toMatchObject({
      cursor: '3',
      created: 4,
      consecutiveFailures: n,
      outcome: n === 5 ? 'failed' : 'running',
    });
  }
});
it('measures apply throttling from the response and keeps the pending tail', async () => {
  const f = fixture();
  f.change({ outcome: 'running', cursor: '3', remaining: ['acme/limited', 'acme/next'] });
  f.apply.mockImplementationOnce(async () => {
    f.advance();
    f.advance();
    return {
      ok: true,
      retryAfterSeconds: 99999,
      value: {
        created: 0,
        existing: 0,
        skipped: 0,
        failed: 1,
        results: [{ repository: 'acme/limited', outcome: 'failed', error: 'rate_limited' }],
        remainingRepositories: ['acme/limited', 'acme/next'],
        nextCursor: '3',
      },
    } as never;
  });
  await f.run();
  expect(f.rule).toMatchObject({
    nextRunAt: '2026-11-04T13:02:00.000Z',
    remaining: ['acme/limited', 'acme/next'],
  });
});
it('resumes disabled progress when re-enabled and emits no second start audit', async () => {
  const f = fixture();
  f.change({
    outcome: 'failed',
    failureReason: 'disabled',
    cursor: null,
    remaining: ['acme/library'],
    created: 4,
  });
  await f.run();
  expect(f.rule).toMatchObject({ created: 5, outcome: 'succeeded' });
  expect(
    f.checkpoint.mock.calls.filter((args) => ((args as unknown[])[3] as unknown[]).length > 0),
  ).toHaveLength(1);
});
it('retains null skip reasons instead of inventing one', async () => {
  const f = fixture();
  f.dryRun.mockResolvedValueOnce({
    ok: true,
    value: {
      entries: [{ repository: 'acme/unknown', action: 'skipped', reason: null }],
      nextCursor: null,
    },
  } as never);
  await f.run();
  expect(f.rule.skips).toEqual([{ repository: 'acme/unknown', reason: null }]);
});

it('writes exactly one start and finish audit for a completed run', async () => {
  const f = fixture();
  f.dryRun.mockResolvedValueOnce({ ok: true, value: { entries: [], nextCursor: null } } as never);
  await f.run();
  expect(
    f.checkpoint.mock.calls
      .flatMap((args) => (args as unknown[])[3] as unknown[])
      .map((a) => (a as { action: string }).action),
  ).toEqual(['discovery_rule.run_started', 'discovery_rule.run_finished']);
  expect(f.checkpoint).toHaveBeenCalledTimes(1);
});

it('persists the failure reset after a successful pending batch', async () => {
  const f = fixture();
  f.change({
    outcome: 'running',
    cursor: '3',
    remaining: ['acme/library'],
    consecutiveFailures: 4,
  });
  await f.run();
  expect(f.rule.consecutiveFailures).toBe(0);
});
it.each(['rate_limited', 'timeout'])(
  'writes one checkpoint for an ongoing %s tick',
  async (error) => {
    const f = fixture();
    f.change({ outcome: 'running', cursor: '3', remaining: ['acme/library'] });
    f.apply.mockResolvedValueOnce({
      ok: true,
      value: {
        created: 0,
        existing: 0,
        skipped: 0,
        failed: 1,
        results: [{ repository: 'acme/library', outcome: 'failed', error }],
        remainingRepositories: ['acme/library'],
      },
    } as never);
    await f.run();
    expect(f.checkpoint).toHaveBeenCalledTimes(1);
  },
);
it.each(['unauthorized', 'forbidden', 'not_found'])(
  'ends a permanent listing failure %s',
  async (error) => {
    const f = fixture();
    f.dryRun.mockResolvedValueOnce({ ok: false, error } as never);
    await f.run();
    expect(f.rule).toMatchObject({
      outcome: 'failed',
      failureReason: 'discovery_failed',
      failed: 1,
    });
  },
);

it('defers partial repository counters and skip entries until its retry completes', async () => {
  const f = fixture();
  f.change({ outcome: 'running', remaining: ['acme/library'], cursor: null });
  const success = [
    { repository: 'acme/library', ecosystem: 'composer', outcome: 'created' },
    { repository: 'acme/library', ecosystem: 'npm', outcome: 'skipped', reason: 'no_manifest' },
  ];
  f.apply.mockResolvedValueOnce({
    ok: true,
    value: {
      created: 1,
      existing: 0,
      skipped: 1,
      failed: 1,
      results: [...success, { repository: 'acme/library', outcome: 'failed', error: 'busy' }],
      remainingRepositories: ['acme/library'],
    },
  } as never);
  await f.run();
  expect(f.rule).toMatchObject({ created: 0, skipped: 0, skips: [], pendingResults: success });
  f.change({ nextRunAt: null });
  f.apply.mockResolvedValueOnce({
    ok: true,
    value: {
      created: 1,
      existing: 0,
      skipped: 1,
      failed: 0,
      results: success,
      remainingRepositories: [],
    },
  } as never);
  await f.run();
  expect((f.apply.mock.calls[1] as unknown[])[3]).toHaveProperty('completedResults', success);
  expect(f.rule).toMatchObject({
    created: 1,
    skipped: 1,
    skips: [{ repository: 'acme/library', reason: 'no_manifest' }],
    pendingResults: [],
    outcome: 'succeeded',
  });
});

it('checkpoints the page and skips apply when planning spent the budget', async () => {
  const f = fixture();
  f.budgetSpent.mockReturnValue(true);
  await f.run();
  expect(f.apply).not.toHaveBeenCalled();
  expect(f.rule).toMatchObject({ remaining: ['acme/library'], cursor: '2', outcome: 'running' });
  expect(f.checkpoint).toHaveBeenCalledTimes(1);
});
it.each(['rate_limited', 'timeout'])(
  'writes one checkpoint when the first listing is %s',
  async (error) => {
    const f = fixture();
    f.dryRun.mockResolvedValueOnce({ ok: false, error } as never);
    await f.run();
    expect(f.checkpoint).toHaveBeenCalledTimes(1);
  },
);

it('counts a successful ecosystem once when the other exhausts retries', async () => {
  const f = fixture();
  f.change({
    outcome: 'running',
    remaining: ['acme/library'],
    consecutiveFailures: 4,
    pendingResults: [{ repository: 'acme/library', ecosystem: 'composer', outcome: 'created' }],
  });
  f.apply.mockResolvedValueOnce({ ok: false, error: 'timeout' } as never);
  await f.run();
  expect(f.rule).toMatchObject({ created: 1, failed: 1, outcome: 'failed', pendingResults: [] });
});
