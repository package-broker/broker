import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../audit/actions.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { JobError, type JobContext, type Jobs } from '../platform/jobs.js';
import {
  createPatOffboardingJob,
  enqueuePatOffboarding,
  enqueueProjectRemovedPatOffboarding,
  PAT_OFFBOARDING_JOB_TYPE,
  type PatOffboardingCause,
  type PatOffboardingStore,
  type RevokePageOutcome,
} from './pat-offboarding.js';

const NOW = '2026-10-20T12:00:00.000Z';
const CUTOFF = '2026-10-20T11:00:00.000Z';
const USER = '01HZX3VQ7N5R8T2W4Y6A9B1C2D';
const ORG = '01J00000000000000000000A0A';
const JOB = '01J0JOB0000000000000000001';
const ctx = orgContext(ORG);

function tokenId(n: number): string {
  return `01J0TOKEN${String(n).padStart(17, '0')}`;
}

function counterIds() {
  let n = 0;
  return {
    ulid: () => {
      n += 1;
      return `01J0EVENT${String(n).padStart(17, '0')}`;
    },
  };
}

interface Harness {
  readonly store: PatOffboardingStore;
  readonly holds: ReturnType<typeof vi.fn>;
  readonly candidates: ReturnType<typeof vi.fn>;
  readonly revokePage: ReturnType<typeof vi.fn>;
  readonly entries: Record<string, unknown>[];
  readonly job: ReturnType<typeof createPatOffboardingJob>;
}

function harness(options: {
  held?: boolean;
  pages?: readonly (readonly string[])[];
  revoke?: (ids: readonly string[], call: number) => RevokePageOutcome;
  logThrows?: boolean;
}): Harness {
  const pages = [...(options.pages ?? [])];
  let call = 0;
  const holds = vi.fn(() => Promise.resolve(options.held ?? false));
  const candidates = vi.fn(() => Promise.resolve(pages.shift() ?? []));
  const revokePage = vi.fn((_ctx: unknown, input: { ids: readonly string[] }) => {
    call += 1;
    return Promise.resolve(
      options.revoke?.(input.ids, call) ?? { status: 'ok' as const, revoked: input.ids },
    );
  });
  const entries: Record<string, unknown>[] = [];
  const store = { holdsAnyGrant: holds, candidates, revokePage } as PatOffboardingStore;
  const job = createPatOffboardingJob({
    store,
    clock: fixedClock(NOW),
    ids: counterIds(),
    log: (entry) => {
      if (options.logThrows === true) throw new Error('sink down');
      entries.push({ ...entry });
    },
  });
  return { store, holds, candidates, revokePage, entries, job };
}

function jobContext(signal: AbortSignal = new AbortController().signal): JobContext {
  return {
    org: ctx,
    jobId: JOB,
    idempotencyKey: 'k',
    attempt: 1,
    fence: 3,
    signal,
    ports: {} as JobContext['ports'],
    observability: {} as JobContext['observability'],
  };
}

async function run(
  h: Harness,
  cause: PatOffboardingCause = 'suspended',
  context: JobContext = jobContext(),
) {
  const payload = h.job.definition.validate({ userId: USER, cause, cutoff: CUTOFF });
  await h.job.definition.handler(payload, context);
}

function events(h: Harness, name: string) {
  return h.entries.filter((entry) => entry.event === name);
}

describe('core:pat-offboarding:v1 definition', () => {
  it('registers as a core job with five attempts', () => {
    const job = harness({}).job;
    expect(job.qualifiedName).toBe('core:pat-offboarding:v1');
    expect(PAT_OFFBOARDING_JOB_TYPE).toBe(job.qualifiedName);
    expect(job.definition.maxAttempts).toBe(5);
  });

  it.each(['suspended', 'membership_removed', 'erased'] as const)('accepts cause %s', (cause) => {
    const job = harness({}).job;
    expect(job.definition.validate({ userId: USER, cause, cutoff: CUTOFF })).toEqual({
      userId: USER,
      cause,
      cutoff: CUTOFF,
    });
  });

  const invalid: ReadonlyArray<readonly [string, unknown]> = [
    ['a bad ULID', { userId: 'not-a-ulid', cause: 'suspended', cutoff: CUTOFF }],
    ['an unknown cause', { userId: USER, cause: 'deleted', cutoff: CUTOFF }],
    [
      'a non-canonical cutoff',
      { userId: USER, cause: 'suspended', cutoff: '2026-10-20T11:00:00Z' },
    ],
    [
      'an impossible cutoff date',
      { userId: USER, cause: 'suspended', cutoff: '2026-02-31T11:00:00.000Z' },
    ],
    ['an extra key', { userId: USER, cause: 'suspended', cutoff: CUTOFF, extra: 1 }],
    ['a missing key', { userId: USER, cause: 'suspended' }],
    ['a non-object payload', 'text'],
    ['an array payload', [USER, 'suspended', CUTOFF]],
  ];
  it.each(invalid)('rejects %s as invalid_payload', (_name, payload) => {
    const job = harness({}).job;
    expect(() => job.definition.validate(payload)).toThrow(
      expect.objectContaining({ name: 'JobError', code: 'invalid_payload' }),
    );
  });
});

describe('core:pat-offboarding:v1 handler', () => {
  it('revokes one short page and reports it', async () => {
    const h = harness({ pages: [[tokenId(1), tokenId(2)]] });
    await run(h);

    expect(h.holds).not.toHaveBeenCalled();
    expect(h.candidates).toHaveBeenCalledTimes(1);
    expect(h.candidates).toHaveBeenCalledWith(ctx, { userId: USER, cutoff: CUTOFF, limit: 25 });
    expect(h.revokePage).toHaveBeenCalledTimes(1);
    const input = h.revokePage.mock.calls[0]?.[1] as {
      userId: string;
      cutoff: string;
      ids: string[];
      now: string;
      opId: string;
      lease: unknown;
      audits: AuditEvent[];
    };
    expect(input).toMatchObject({
      userId: USER,
      cutoff: CUTOFF,
      ids: [tokenId(1), tokenId(2)],
      now: NOW,
      lease: { jobId: JOB, fence: 3 },
    });
    expect(input.audits).toHaveLength(2);
    for (const [index, audit] of input.audits.entries()) {
      expect(audit.action).toBe('token.revoke');
      expect(audit.actor).toEqual({ type: 'system', id: null });
      expect(audit.target).toEqual({ type: 'token', id: input.ids[index] });
      expect(audit.occurredAt).toBe(NOW);
      const payload = JSON.parse(audit.payloadJson) as Record<string, unknown>;
      expect(payload).toMatchObject({
        op_id: input.opId,
        changes: { cause: { new: 'suspended' } },
      });
    }
    expect(new Set(input.audits.map((audit) => audit.id)).size).toBe(2);
    expect(events(h, 'token.revoked')).toEqual([
      {
        level: 'info',
        event: 'token.revoked',
        orgId: ORG,
        tokenId: tokenId(1),
        kind: 'pat',
        via: 'offboarding',
        cause: 'suspended',
        actorUserId: null,
        jobId: JOB,
      },
      expect.objectContaining({ tokenId: tokenId(2) }),
    ]);
    expect(events(h, 'token.offboarding_done')).toEqual([
      {
        level: 'info',
        event: 'token.offboarding_done',
        orgId: ORG,
        userId: USER,
        cause: 'suspended',
        revoked: 2,
      },
    ]);
  });

  it('pages 60 candidates as 25, 25 and 10', async () => {
    const all = Array.from({ length: 60 }, (_, index) => tokenId(index + 1));
    const h = harness({ pages: [all.slice(0, 25), all.slice(25, 50), all.slice(50)] });
    await run(h);

    const sizes = h.revokePage.mock.calls.map((call) => (call[1] as { ids: string[] }).ids.length);
    expect(sizes).toEqual([25, 25, 10]);
    expect(h.candidates).toHaveBeenCalledTimes(3);
    expect(events(h, 'token.revoked')).toHaveLength(60);
    expect(events(h, 'token.offboarding_done')[0]).toMatchObject({ revoked: 60 });
    const opIds = h.revokePage.mock.calls.map((call) => (call[1] as { opId: string }).opId);
    expect(new Set(opIds).size).toBe(3);
  });

  it('asks for another page after a full last page and stops on the empty one', async () => {
    const full = Array.from({ length: 25 }, (_, index) => tokenId(index + 1));
    const h = harness({ pages: [full] });
    await run(h);

    expect(h.candidates).toHaveBeenCalledTimes(2);
    expect(h.revokePage).toHaveBeenCalledTimes(1);
  });

  it('ends without a revoke when there is nothing to revoke', async () => {
    const h = harness({ pages: [] });
    await run(h);

    expect(h.revokePage).not.toHaveBeenCalled();
    expect(events(h, 'token.offboarding_done')[0]).toMatchObject({ revoked: 0 });
  });

  it('skips a membership removal while the user still holds a grant', async () => {
    const h = harness({ held: true, pages: [[tokenId(1)]] });
    await run(h, 'membership_removed');

    expect(h.holds).toHaveBeenCalledWith(ctx, USER, CUTOFF);
    expect(h.candidates).not.toHaveBeenCalled();
    expect(h.revokePage).not.toHaveBeenCalled();
    expect(events(h, 'token.offboarding_skipped')).toEqual([
      {
        level: 'info',
        event: 'token.offboarding_skipped',
        orgId: ORG,
        userId: USER,
        cause: 'membership_removed',
        reason: 'still_member',
      },
    ]);
    expect(events(h, 'token.offboarding_done')).toEqual([]);
  });

  it('revokes a membership removal when no grant is left', async () => {
    const h = harness({ held: false, pages: [[tokenId(1)]] });
    await run(h, 'membership_removed');

    expect(h.holds).toHaveBeenCalledTimes(1);
    expect(h.revokePage).toHaveBeenCalledTimes(1);
    expect(events(h, 'token.revoked')[0]).toMatchObject({ cause: 'membership_removed' });
  });

  it.each(['suspended', 'erased'] as const)(
    'does not look for grants when the cause is %s',
    async (cause) => {
      const h = harness({ held: true, pages: [[tokenId(1)]] });
      await run(h, cause);

      expect(h.holds).not.toHaveBeenCalled();
      expect(h.revokePage).toHaveBeenCalledTimes(1);
    },
  );

  it('throws the lease-lost error and reports nothing as revoked', async () => {
    const h = harness({ pages: [[tokenId(1)]], revoke: () => 'lease_lost' });

    await expect(run(h)).rejects.toMatchObject({ name: 'JobError', code: 'lease_lost' });
    expect(events(h, 'token.revoked')).toEqual([]);
    expect(events(h, 'token.offboarding_done')).toEqual([]);
  });

  it('throws a retryable error when the page outcome is indeterminate', async () => {
    const h = harness({ pages: [[tokenId(1)]], revoke: () => 'indeterminate' });

    await expect(run(h)).rejects.toBeInstanceOf(JobError);
    expect(events(h, 'token.revoked')).toEqual([]);
    expect(events(h, 'token.offboarding_done')).toEqual([]);
  });

  it('emits token.revoked only for the ids the page changed and still runs the next page', async () => {
    const first = Array.from({ length: 25 }, (_, index) => tokenId(index + 1));
    const second = [tokenId(26), tokenId(27)];
    const h = harness({
      pages: [first, second],
      revoke: (ids, call) => ({
        status: 'ok',
        revoked: call === 1 ? ids.filter((id) => id !== tokenId(3)) : ids,
      }),
    });
    await run(h);

    expect(h.revokePage).toHaveBeenCalledTimes(2);
    const revoked = events(h, 'token.revoked').map((entry) => entry.tokenId);
    expect(revoked).toHaveLength(26);
    expect(revoked).not.toContain(tokenId(3));
    expect(events(h, 'token.offboarding_done')[0]).toMatchObject({ revoked: 26 });
  });

  it('ignores a revoked id the page was not asked to revoke', async () => {
    const h = harness({
      pages: [[tokenId(1)]],
      revoke: () => ({ status: 'ok', revoked: [tokenId(1), tokenId(99)] }),
    });
    await run(h);

    expect(events(h, 'token.revoked').map((entry) => entry.tokenId)).toEqual([tokenId(1)]);
    expect(events(h, 'token.offboarding_done')[0]).toMatchObject({ revoked: 1 });
  });

  it('fails instead of looping when a page returns an id it already submitted', async () => {
    const full = Array.from({ length: 25 }, (_, index) => tokenId(index + 1));
    const h = harness({
      pages: [full, full],
      revoke: () => ({ status: 'ok', revoked: [] }),
    });

    await expect(run(h)).rejects.toBeInstanceOf(JobError);
    expect(h.revokePage).toHaveBeenCalledTimes(1);
  });

  it('stops between pages when the signal aborts and reports an aborted job', async () => {
    const controller = new AbortController();
    const full = Array.from({ length: 25 }, (_, index) => tokenId(index + 1));
    const h = harness({
      pages: [full, [tokenId(26)]],
      revoke: (ids) => {
        controller.abort();
        return { status: 'ok', revoked: ids };
      },
    });

    await expect(run(h, 'suspended', jobContext(controller.signal))).rejects.toMatchObject({
      name: 'JobError',
      code: 'aborted',
    });
    expect(h.revokePage).toHaveBeenCalledTimes(1);
    expect(events(h, 'token.offboarding_done')).toEqual([]);
  });

  it('does not touch the store when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ pages: [[tokenId(1)]] });

    await expect(run(h, 'suspended', jobContext(controller.signal))).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(h.candidates).not.toHaveBeenCalled();
  });

  it('survives a failing log sink after the revoke is stored', async () => {
    const h = harness({ pages: [[tokenId(1)]], logThrows: true });

    await expect(run(h)).resolves.toBeUndefined();
    expect(h.revokePage).toHaveBeenCalledTimes(1);
  });

  it('puts no e-mail, token name or selector in any event', async () => {
    const h = harness({ pages: [[tokenId(1)]] });
    await run(h);

    const text = JSON.stringify(h.entries);
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/selector|name|email/i);
  });
});

describe('enqueuePatOffboarding', () => {
  function jobs() {
    const enqueue = vi.fn(() => Promise.resolve({ id: 'job', created: true }));
    return { enqueue, port: { enqueue } as Pick<Jobs, 'enqueue'> };
  }

  it('enqueues the job with an idempotency key and a per-user resource key', async () => {
    const { enqueue, port } = jobs();
    await enqueuePatOffboarding(port)(ctx, { userId: USER, cause: 'suspended', at: CUTOFF });

    expect(enqueue).toHaveBeenCalledWith(
      ctx,
      'core:pat-offboarding:v1',
      { userId: USER, cause: 'suspended', cutoff: CUTOFF },
      {
        idempotencyKey: `pat-offboarding:${USER}:suspended:${CUTOFF}`,
        resourceKey: `user:${USER}`,
      },
    );
  });

  it('refuses an invalid cutoff before enqueueing', async () => {
    const { enqueue, port } = jobs();

    await expect(
      enqueuePatOffboarding(port)(ctx, { userId: USER, cause: 'suspended', at: 'yesterday' }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('core:pat-offboarding:v1 project_removed', () => {
  it('accepts the cause', () => {
    const job = harness({}).job;
    expect(
      job.definition.validate({ userId: USER, cause: 'project_removed', cutoff: CUTOFF }),
    ).toEqual({ userId: USER, cause: 'project_removed', cutoff: CUTOFF });
  });

  it('asks only for selected tokens and never consults the organization-wide grant check', async () => {
    const h = harness({ held: true, pages: [[tokenId(1)]] });
    await run(h, 'project_removed');

    expect(h.holds).not.toHaveBeenCalled();
    expect(h.candidates).toHaveBeenCalledWith(ctx, {
      userId: USER,
      cutoff: CUTOFF,
      limit: 25,
      selectedOnly: true,
    });
    expect(h.revokePage.mock.calls[0]?.[1]).toMatchObject({
      userId: USER,
      cutoff: CUTOFF,
      ids: [tokenId(1)],
      selectedOnly: true,
    });
  });

  it('stamps the audit and the log with the cause', async () => {
    const h = harness({ pages: [[tokenId(1)]] });
    await run(h, 'project_removed');

    const input = h.revokePage.mock.calls[0]?.[1] as { audits: AuditEvent[] };
    const payload = JSON.parse(input.audits[0]?.payloadJson ?? '{}') as Record<string, unknown>;
    expect(payload).toMatchObject({ changes: { cause: { new: 'project_removed' } } });
    expect(events(h, 'token.revoked')).toHaveLength(1);
    expect(events(h, 'token.revoked')[0]).toMatchObject({ cause: 'project_removed', kind: 'pat' });
    expect(events(h, 'token.offboarding_done')[0]).toMatchObject({
      cause: 'project_removed',
      revoked: 1,
    });
  });

  it.each(['suspended', 'membership_removed', 'erased'] as const)(
    'does not narrow the %s cause to selected tokens',
    async (cause) => {
      const h = harness({ pages: [[tokenId(1)]] });
      await run(h, cause);

      expect(h.candidates).toHaveBeenCalledWith(ctx, { userId: USER, cutoff: CUTOFF, limit: 25 });
      expect(h.revokePage.mock.calls[0]?.[1]).not.toHaveProperty('selectedOnly');
    },
  );
});

describe('enqueueProjectRemovedPatOffboarding', () => {
  it('enqueues the project_removed job keyed by user and instant', async () => {
    const enqueue = vi.fn(() => Promise.resolve({ id: 'job', created: true }));
    await enqueueProjectRemovedPatOffboarding({ enqueue } as Pick<Jobs, 'enqueue'>)(ctx, {
      userId: USER,
      at: CUTOFF,
    });

    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      ctx,
      'core:pat-offboarding:v1',
      { userId: USER, cause: 'project_removed', cutoff: CUTOFF },
      {
        idempotencyKey: `pat-offboarding:${USER}:project_removed:${CUTOFF}`,
        resourceKey: `user:${USER}`,
      },
    );
  });
});

describe('durable selected-PAT invalidation payload', () => {
  it('accepts a token captured by the access-loss batch', () => {
    const payload = {
      userId: USER,
      cause: 'project_removed',
      cutoff: CUTOFF,
      invalidatedTokenId: USER,
    };
    expect(harness({}).job.definition.validate(payload)).toEqual(payload);
  });

  it.each(['suspended', 'membership_removed', 'erased'])(
    'refuses a token snapshot for %s',
    (cause) => {
      expect(() =>
        harness({}).job.definition.validate({
          userId: USER,
          cause,
          cutoff: CUTOFF,
          invalidatedTokenId: USER,
        }),
      ).toThrow(expect.objectContaining({ code: 'invalid_payload' }));
    },
  );

  it('refuses a malformed captured token id', () => {
    expect(() =>
      harness({}).job.definition.validate({
        userId: USER,
        cause: 'project_removed',
        cutoff: CUTOFF,
        invalidatedTokenId: 'invalid',
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_payload' }));
  });
});
