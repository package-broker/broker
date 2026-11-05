import { DbError } from '../../db/errors.js';
import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../audit/actions.js';
import type { PolicyVersionFacts } from '../../db/package-admin.js';
import type { PolicyRule } from '../../db/registry-policy.js';
import { POLICY_NOW, policyCallerOf } from '../../test-support/policy-manage.js';
import { createPolicyInspectService, POLICY_INSPECT_PAGE_MAX } from './inspect.js';

const PACKAGE = '01J0PKG0000000000000000001';
const BLOCK = '01J0P0000000000000000000B1';
const AGE = '01J0P0000000000000000000A1';
const CANARY = 'https://user:secret-token@registry.invalid/left-pad.tgz';

function fact(version: string, overrides: Partial<PolicyVersionFacts> = {}): PolicyVersionFacts {
  return {
    packageId: PACKAGE,
    sourceId: 'S1',
    ecosystem: 'npm',
    packageKey: 'left-pad',
    versionId: `01J0VER00000000000000000${version.replaceAll('.', '').padStart(2, '0')}`,
    version,
    versionNormalized: version,
    revision: 1,
    status: 'active',
    publishedAt: '2026-10-01T00:00:00.000Z',
    publishedAtBasis: 'release_date',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function rule(overrides: Partial<PolicyRule>): PolicyRule {
  return {
    id: BLOCK,
    projectId: null,
    ecosystem: 'npm',
    packageKey: 'left-pad',
    kind: 'block',
    minAgeSeconds: null,
    clientFamily: null,
    clientMinVersion: null,
    denyUnknown: false,
    reasonCode: 'security_review',
    incidentId: null,
    expiresAt: null,
    revision: 2,
    members: ['1.0.0'],
    ...overrides,
  };
}

function setup(
  options: { visible?: boolean; rules?: PolicyRule[]; facts?: PolicyVersionFacts[] } = {},
) {
  const events: AuditEvent[] = [];
  const facts = options.facts ?? [
    fact('1.0.0', { status: 'quarantined' }),
    fact('2.0.0', { publishedAt: '2026-11-01T12:00:00.000Z' }),
    fact('3.0.0', { publishedAtBasis: 'import_time' }),
  ];
  const deps = {
    policy: {
      snapshot: vi.fn(async () => ({
        epoch: 'e1',
        rules: options.rules ?? [
          rule({}),
          rule({
            id: AGE,
            kind: 'min_age',
            packageKey: null,
            minAgeSeconds: 7 * 86_400,
            members: [],
          }),
        ],
      })),
    },
    facts: { versionFacts: vi.fn(async () => facts) },
    packages: {
      listVersions: vi.fn(async () =>
        options.visible === false ? null : { items: [], next: null },
      ),
    },
    audit: {
      record: vi.fn(async (_ctx: unknown, list: readonly AuditEvent[]) => {
        events.push(...list);
      }),
    },
    ids: { ulid: () => '01J0A0D0000000000000000001' },
    clock: { now: () => new Date(POLICY_NOW) },
  };
  return { deps, events, service: createPolicyInspectService(deps) };
}

describe('policy manager diagnostics', () => {
  it('shows ids, status, date basis and fixed reasons for each version', async () => {
    const { service } = setup();
    const result = await service.inspect(policyCallerOf(), { packageId: PACKAGE, limit: 10 });
    expect(result).toMatchObject({
      ok: true,
      value: {
        packageId: PACKAGE,
        ecosystem: 'npm',
        package: 'left-pad',
        next: null,
        versions: [
          {
            version: '1.0.0',
            status: 'quarantined',
            ageBasis: 'published',
            permitted: false,
            reasons: [{ ruleId: BLOCK, ruleRevision: 2, reason: 'blocked' }],
          },
          {
            version: '2.0.0',
            permitted: false,
            reasons: [{ ruleId: AGE, ruleRevision: 2, reason: 'min_age' }],
          },
          { version: '3.0.0', ageBasis: 'imported', permitted: true, reasons: [] },
        ],
      },
    });
  });

  it('refuses readers and callers without package management, before reading anything', async () => {
    const { deps, service } = setup();
    for (const caller of [
      policyCallerOf({
        organizationPermissions: new Set(['org:packages:read', 'org:settings:write']),
      }),
      policyCallerOf({ fence: null }),
      policyCallerOf({
        routeProjectId: 'P1',
        organizationPermissions: new Set(),
        projectPermissions: new Set(['project:packages:read']),
      }),
    ]) {
      expect(await service.inspect(caller, { packageId: PACKAGE, limit: 10 })).toEqual({
        ok: false,
        error: 'forbidden',
      });
    }
    expect(deps.packages.listVersions).not.toHaveBeenCalled();
    expect(deps.facts.versionFacts).not.toHaveBeenCalled();
    expect(deps.policy.snapshot).not.toHaveBeenCalled();
  });

  it('keeps a project manager to packages and rules of the managed project', async () => {
    const { deps, service } = setup({ visible: false });
    const manager = policyCallerOf({
      routeProjectId: 'P1',
      organizationPermissions: new Set(),
      projectPermissions: new Set(['project:packages:manage']),
    });
    expect(await service.inspect(manager, { packageId: PACKAGE, limit: 10 })).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(deps.packages.listVersions).toHaveBeenCalledWith(expect.anything(), {
      packageId: PACKAGE,
      projectId: 'P1',
      limit: 1,
    });
    expect(deps.facts.versionFacts).not.toHaveBeenCalled();
    const visible = setup();
    await visible.service.inspect(manager, { packageId: PACKAGE, limit: 10 });
    expect(visible.deps.policy.snapshot).toHaveBeenCalledWith(expect.anything(), {
      ecosystem: 'npm',
      projectId: 'P1',
      packageKey: 'left-pad',
    });
  });

  it('carries no manifest, readme, source or download URL and no secret marker', async () => {
    const { service, events } = setup({
      facts: [fact('1.0.0', { sourceId: CANARY } as Partial<PolicyVersionFacts>)],
    });
    const result = await service.inspect(policyCallerOf(), { packageId: PACKAGE, limit: 10 });
    const text = JSON.stringify(result);
    for (const marker of ['secret-token', 'https://', 'tarball', 'readme', 'manifest', 'S1']) {
      expect(text).not.toContain(marker);
    }
    expect(JSON.stringify(events)).not.toContain('secret-token');
    expect(
      Object.keys(
        (result as unknown as { value: { versions: object[] } }).value.versions[0]!,
      ).sort(),
    ).toEqual([
      'ageBasis',
      'effectiveAt',
      'id',
      'permitted',
      'reasons',
      'revision',
      'status',
      'version',
    ]);
  });

  it('records every inspection and fails closed when the audit cannot be written', async () => {
    const { deps, events, service } = setup();
    await service.inspect(policyCallerOf(), { packageId: PACKAGE, limit: 10 });
    expect(events.map((event) => [event.action, event.target, event.actor])).toEqual([
      ['policy.inspect', { type: 'package', id: PACKAGE }, { type: 'user', id: 'user-1' }],
    ]);
    expect(JSON.parse(events[0]!.payloadJson)).toMatchObject({
      changes: {
        scope: { new: 'organization' },
        package_key: { new: 'left-pad' },
        result_count: { new: 3 },
      },
    });
    deps.audit.record.mockRejectedValueOnce(new Error('down'));
    expect(await service.inspect(policyCallerOf(), { packageId: PACKAGE, limit: 10 })).toEqual({
      ok: false,
      error: 'unavailable',
    });
  });

  it('fails closed when the rules cannot be read and pages by version id', async () => {
    const { deps, service } = setup();
    deps.policy.snapshot.mockRejectedValueOnce(new Error('db'));
    expect(await service.inspect(policyCallerOf(), { packageId: PACKAGE, limit: 10 })).toEqual({
      ok: false,
      error: 'unavailable',
    });
    const paged = await service.inspect(policyCallerOf(), { packageId: PACKAGE, limit: 2 });
    expect(paged).toMatchObject({ ok: true, value: { next: fact('2.0.0').versionId } });
    expect(deps.facts.versionFacts).toHaveBeenLastCalledWith(expect.anything(), {
      packageId: PACKAGE,
      limit: 3,
    });
  });

  it('reports organization rules to a project-only manager without their ids or revisions', async () => {
    const PROJECT_BLOCK = '01J0P0000000000000000000B2';
    const rules = [
      rule({}),
      rule({ id: AGE, kind: 'min_age', packageKey: null, minAgeSeconds: 7 * 86_400, members: [] }),
      rule({ id: PROJECT_BLOCK, projectId: 'P1', revision: 5, members: ['3.0.0'] }),
    ];
    const projectOnly = policyCallerOf({
      routeProjectId: 'P1',
      organizationPermissions: new Set(),
      projectPermissions: new Set(['project:packages:manage']),
    });
    const hidden = await setup({ rules }).service.inspect(projectOnly, {
      packageId: PACKAGE,
      limit: 10,
    });
    expect(hidden).toMatchObject({
      ok: true,
      value: {
        versions: [
          { version: '1.0.0', permitted: false, reasons: [{ reason: 'organization_rule' }] },
          { version: '2.0.0', permitted: false, reasons: [{ reason: 'organization_rule' }] },
          {
            version: '3.0.0',
            permitted: false,
            reasons: [{ ruleId: PROJECT_BLOCK, ruleRevision: 5, reason: 'blocked' }],
          },
        ],
      },
    });
    const text = JSON.stringify(hidden);
    expect(text).not.toContain(BLOCK);
    expect(text).not.toContain(AGE);
    for (const version of (
      hidden as unknown as { value: { versions: { reasons: object[] }[] } }
    ).value.versions.slice(0, 2)) {
      expect(version.reasons).toEqual([{ reason: 'organization_rule' }]);
    }

    const organizationManager = policyCallerOf({
      routeProjectId: 'P1',
      projectPermissions: new Set(['project:packages:manage']),
    });
    expect(
      await setup({ rules }).service.inspect(organizationManager, {
        packageId: PACKAGE,
        limit: 10,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        versions: [
          { reasons: [{ ruleId: BLOCK, ruleRevision: 2, reason: 'blocked' }] },
          { reasons: [{ ruleId: AGE, ruleRevision: 2, reason: 'min_age' }] },
          { reasons: [{ ruleId: PROJECT_BLOCK, ruleRevision: 5, reason: 'blocked' }] },
        ],
      },
    });
  });

  it('caps a page at the diagnostics maximum whatever the caller asks for', async () => {
    const { deps, service } = setup();
    await service.inspect(policyCallerOf(), { packageId: PACKAGE, limit: 5000 });
    expect(deps.facts.versionFacts).toHaveBeenLastCalledWith(expect.anything(), {
      packageId: PACKAGE,
      limit: POLICY_INSPECT_PAGE_MAX + 1,
    });
  });
});

it.each(['policy', 'audit'] as const)(
  'preserves audit backlog refusal at inspection %s boundary',
  async (boundary) => {
    const { deps, service } = setup();
    const error = new DbError('backlog_full', 'Audit backlog is full');
    if (boundary === 'policy') deps.policy.snapshot.mockRejectedValueOnce(error);
    else deps.audit.record.mockRejectedValueOnce(error);
    await expect(service.inspect(policyCallerOf(), { packageId: PACKAGE, limit: 10 })).rejects.toBe(
      error,
    );
  },
);
