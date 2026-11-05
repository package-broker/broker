import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../../db/port.js';
import {
  POLICY_EXPIRY_PAGE,
  type PolicyExpiryDue,
  type PolicyRule,
  type RegistryPolicyExpiry,
} from '../../db/registry-policy.js';
import { fixedClock, ulid } from '../../ids.js';
import { jobFences } from '../../platform/job-fences.js';
import type { JobContext } from '../../platform/jobs.js';
import { registryPolicyJobs } from '../../runtime/policy-jobs.js';
import { resolveRegistryConfig } from '../registry-config.js';
import { evaluateMembers } from './members.js';
import {
  createRegistryPolicyExpiryJob,
  REGISTRY_POLICY_EXPIRE_JOB,
  REGISTRY_POLICY_EXPIRY_DEFERRED_EVENT,
} from './expiry.js';

const NOW = '2026-11-02T10:00:00.000Z';

function due(index: number): PolicyExpiryDue {
  return {
    id: `01J0P00000000000000000${String(index).padStart(4, '0')}`,
    projectId: null,
    ecosystem: 'npm',
    kind: 'block',
    packageKey: 'left-pad',
    revision: 3,
    expiresAt: '2026-11-01T00:00:00.000Z',
  };
}

function fixture(rows: PolicyExpiryDue[], marked = true) {
  const expiry: RegistryPolicyExpiry = {
    due: vi.fn(async () => rows),
    mark: vi.fn(async () => marked),
  };
  const enqueue = vi.fn().mockResolvedValue({ id: ulid(), created: true });
  const context = {
    org: orgContext('org-a'),
    jobId: ulid(),
    fence: 1,
    fences: jobFences({ id: 'J', owner: 'O', fence: 1 }),
    signal: new AbortController().signal,
    ports: { platform: { jobs: { enqueue } }, clock: fixedClock(NOW), ids: { ulid } },
  } as unknown as JobContext;
  return { expiry, enqueue, context, job: createRegistryPolicyExpiryJob(expiry) };
}

describe('registry policy expiry bookkeeping job', () => {
  it('runs hourly per organization and refuses a payload', () => {
    const f = fixture([]);
    expect(f.job.schedule).toEqual({ everySeconds: 3600 });
    expect(() => f.job.validate({ orgId: 'other' })).toThrow('invalid_payload');
  });

  it('marks each due rule at its read revision with the leased purge fence of its organization', async () => {
    const f = fixture([due(1), due(2)]);
    await f.job.handler({}, f.context);
    expect(f.expiry.due).toHaveBeenCalledWith(f.context.org, POLICY_EXPIRY_PAGE);
    expect(
      vi
        .mocked(f.expiry.mark)
        .mock.calls.map(([org, fence, input]) => [org, fence, input.id, input.revision]),
    ).toEqual([
      [f.context.org, expect.objectContaining({ writer: 'purge' }), due(1).id, 3],
      [f.context.org, expect.objectContaining({ writer: 'purge' }), due(2).id, 3],
    ]);
    const [, , input] = vi.mocked(f.expiry.mark).mock.calls[0]!;
    expect(Object.keys(input).sort()).toEqual(['audit', 'id', 'revision']);
    expect(input.audit.context).toMatchObject({ requestId: f.context.jobId, sourceIp: null });
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('continues a full page in a follow-up job and stops when nothing was marked', async () => {
    const rows = Array.from({ length: POLICY_EXPIRY_PAGE }, (_, index) => due(index));
    const f = fixture(rows);
    await f.job.handler({}, f.context);
    expect(f.enqueue).toHaveBeenCalledWith(
      f.context.org,
      REGISTRY_POLICY_EXPIRE_JOB,
      {},
      {
        idempotencyKey: `${f.context.jobId}:${rows.at(-1)!.id}:3`,
      },
    );
    const raced = fixture(rows, false);
    await raced.job.handler({}, raced.context);
    expect(raced.enqueue).not.toHaveBeenCalled();
  });

  it('finishes a full page without a jobs port after its marks and leaves the rest to the next run', async () => {
    const rows = Array.from({ length: POLICY_EXPIRY_PAGE }, (_, index) => due(index));
    const f = fixture(rows);
    const log = vi.fn();
    const context = {
      ...f.context,
      ports: { ...f.context.ports, platform: undefined },
      observability: { log, counter: vi.fn(), histogram: vi.fn() },
    } as unknown as JobContext;
    await expect(f.job.handler({}, context)).resolves.toBeUndefined();
    expect(f.expiry.mark).toHaveBeenCalledTimes(POLICY_EXPIRY_PAGE);
    expect(log).toHaveBeenCalledWith({
      level: 'warn',
      event: REGISTRY_POLICY_EXPIRY_DEFERRED_EVENT,
    });
  });

  it('refuses an unleased run and stops on cancellation', async () => {
    const f = fixture([due(1)]);
    await expect(
      f.job.handler({}, { ...f.context, fences: undefined } as unknown as JobContext),
    ).rejects.toThrow('lease_lost');
    const controller = new AbortController();
    controller.abort();
    await f.job.handler({}, { ...f.context, signal: controller.signal });
    expect(f.expiry.due).not.toHaveBeenCalled();
  });

  it('is registered only while registry policy is enabled', () => {
    const expiry = vi.fn();
    const off = resolveRegistryConfig(undefined, 'node', 'https://broker.test');
    const on = resolveRegistryConfig({ policy: { enabled: true } }, 'node', 'https://broker.test');
    expect(registryPolicyJobs(off, expiry)).toEqual([]);
    expect(expiry).not.toHaveBeenCalled();
    expect(registryPolicyJobs(on, expiry).map((job) => [job.name, job.version])).toEqual([
      ['registry-policy-expire', 1],
    ]);
  });

  it('lets an expired block or allowlist stop restricting without any job tick', () => {
    const rule = (kind: 'block' | 'allowlist'): PolicyRule => ({
      id: '01J0P0000000000000000000R1',
      projectId: null,
      ecosystem: 'npm',
      packageKey: 'left-pad',
      kind,
      minAgeSeconds: null,
      clientFamily: null,
      clientMinVersion: null,
      denyUnknown: false,
      reasonCode: 'security_review',
      incidentId: null,
      expiresAt: '2026-11-02T09:59:59.999Z',
      revision: 1,
      members: kind === 'block' ? ['1.0.0'] : [],
    });
    const fact = {
      packageId: 'P',
      sourceId: 'S',
      packageKey: 'left-pad',
      versionId: 'V',
      version: '1.0.0',
      normalizedVersion: '1.0.0',
      revision: 1,
      publishedAt: '2026-01-01T00:00:00.000Z',
      ageBasis: 'published' as const,
    };
    for (const kind of ['block', 'allowlist'] as const) {
      expect(evaluateMembers([rule(kind)], fact, '2026-11-02T09:59:59.998Z').denials).toHaveLength(
        1,
      );
      expect(evaluateMembers([rule(kind)], fact, NOW).denials).toEqual([]);
    }
  });
});
