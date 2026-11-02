import { describe, expect, it, vi } from 'vitest';
import type {
  PackageDetailRepository,
  PolicyVersionFacts,
  PolicyVersionFactsReader,
} from '../../db/package-admin.js';
import type { PolicyRule } from '../../db/registry-policy.js';
import { fixedClock } from '../../ids.js';
import { setContextPackageActor } from '../../internal/package-actor.js';
import type { RequestContext } from '../../plugin.js';
import { createPolicyServing } from '../../registry/policy/serving.js';
import {
  policyRule,
  projectActor,
  sessionSetup,
} from '../../test-support/registry-policy-session.js';
import { packageDetailRoutes } from './package-detail.js';

const PKG = '01J0K0000000000000000000PA';
const V1 = '01J0K0000000000000000000V1';
const V2 = '01J0K0000000000000000000V2';
const BLOCK = '01J0P0000000000000000000B1';

function row(versionId: string, version: string): PolicyVersionFacts {
  return {
    packageId: PKG,
    sourceId: 'S',
    ecosystem: 'npm',
    packageKey: 'widget',
    versionId,
    version,
    versionNormalized: version,
    revision: 1,
    status: 'active',
    publishedAt: '2025-01-01T00:00:00.000Z',
    publishedAtBasis: 'release_date',
    createdAt: '2025-01-01T00:00:00.000Z',
  };
}

function fixture(
  options: { rules?: PolicyRule[]; governed?: boolean; facts?: PolicyVersionFacts[] } = {},
) {
  const readmes: Record<string, { filename: string; body: string; versionId: string }> = {
    latest: { filename: 'README.md', body: '# Two', versionId: V2 },
    '1.0.0': { filename: 'README.md', body: '# One', versionId: V1 },
    '2.0.0': { filename: 'README.md', body: '# Two', versionId: V2 },
  };
  const repository: PackageDetailRepository = {
    detail: vi.fn(async () => null),
    packageName: vi.fn(async () => 'widget'),
    readme: vi.fn(async (_ctx, query) => readmes[query.version ?? 'latest'] ?? null),
    setAccess: vi.fn(async () => ({ ok: true as const })),
  };
  const rows = options.facts ?? [row(V1, '1.0.0'), row(V2, '2.0.0')];
  const facts: PolicyVersionFactsReader = {
    versionFacts: vi.fn(async (_ctx, query) =>
      rows.filter(
        (entry) =>
          entry.packageId === query.packageId &&
          (query.versionIds === undefined || query.versionIds.includes(entry.versionId)),
      ),
    ),
  };
  const actor = projectActor({ projectId: '01J0K0000000000000000000PJ' });
  const setup = sessionSetup({ actor, rules: options.rules ?? [] });
  const [readme] = packageDetailRoutes({
    repository,
    clock: fixedClock('2026-11-01T00:00:00Z'),
    ids: { ulid: () => '01J0R0000000000000000000R1' },
    clientIp: () => null,
    idempotency: { find: async () => null },
    ...(options.governed === false
      ? {}
      : { policy: { serving: createPolicyServing(setup.deps), facts } }),
  });
  const get = (version?: string) => {
    const ctx = {
      request: new Request(
        `https://broker.test/_pb/projects/demo/packages/${PKG}/readme${version === undefined ? '' : `?version=${version}`}`,
      ),
      requestId: '01J0R0000000000000000000R1',
      org: { orgId: actor.orgId },
      principal: { kind: 'user', id: actor.userId },
      projectId: actor.projectId,
      params: { project: 'demo', package: PKG },
      ports: {},
    } as unknown as RequestContext;
    setContextPackageActor(ctx, actor);
    return readme!.handler(ctx);
  };
  return { get, repository, facts, setup };
}

describe('version-bound readme', () => {
  it('a blocked version has no readme; the allowed control renders without internal identity', async () => {
    const { get } = fixture({
      rules: [policyRule(BLOCK, { packageKey: 'widget', members: ['1.0.0'] })],
    });
    const blocked = await get('1.0.0');
    expect(blocked.status).toBe(404);
    expect(await blocked.json()).toMatchObject({ error: { code: 'not_found' } });
    const allowed = await get('2.0.0');
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      filename: 'README.md',
      body: '# Two',
      contentType: 'text/markdown',
      sizeBytes: 5,
    });
  });

  it('a hidden latest target is not replaced by another version', async () => {
    const { get, repository } = fixture({
      rules: [policyRule(BLOCK, { packageKey: 'widget', members: ['2.0.0'] })],
    });
    expect((await get()).status).toBe(404);
    expect(repository.readme).toHaveBeenCalledTimes(1);
  });

  it("a readme whose version facts are not the organization's own stays hidden", async () => {
    const { get } = fixture({ facts: [] });
    expect((await get('1.0.0')).status).toBe(404);
  });

  it('a readme without a resolved version identity is never served under policy', async () => {
    const { get, repository } = fixture();
    vi.mocked(repository.readme).mockResolvedValueOnce({ filename: 'README.md', body: '# X' });
    expect((await get('1.0.0')).status).toBe(404);
  });

  it('a hidden readme writes no durable evidence and an audit outage does not matter', async () => {
    const { get, setup } = fixture({
      rules: [policyRule(BLOCK, { packageKey: 'widget', members: ['1.0.0'] })],
    });
    expect((await get('1.0.0')).status).toBe(404);
    expect(setup.audit.state.calls).toBe(0);
  });

  it('with the flag off the readme is served as before and the version identity never leaks', async () => {
    const { get, facts } = fixture({
      governed: false,
      rules: [policyRule(BLOCK, { packageKey: 'widget', members: ['1.0.0'] })],
    });
    const response = await get('1.0.0');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      filename: 'README.md',
      body: '# One',
      contentType: 'text/markdown',
      sizeBytes: 5,
    });
    expect(facts.versionFacts).not.toHaveBeenCalled();
  });

  it('a client floor that refuses unknown clients does not hide a readme from the browser', async () => {
    const { get } = fixture({
      rules: [
        policyRule('01J0P0000000000000000000F1', {
          kind: 'client_floor',
          packageKey: null,
          clientFamily: 'npm',
          clientMinVersion: '1.0.0',
          denyUnknown: true,
        }),
      ],
    });
    const response = await get('1.0.0');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ body: '# One' });
  });

  it('an unreadable policy is the fixed 503', async () => {
    const { get, setup } = fixture();
    setup.policy.state.fail = true;
    const response = await get('1.0.0');
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
  });
});
