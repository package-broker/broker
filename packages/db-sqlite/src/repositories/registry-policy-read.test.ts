import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_POLICY_NAMESPACE_RULES,
  RegistryPolicyStoreError,
  policyPackageView,
} from '@package-broker/core/db/registry-policy';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { seeder, type Seed } from '../testing/mutation-table/harness.js';
import { seedProject } from '../testing/mutation-table/fixtures.js';
import { seedMember, seedRule } from '../contract/registry-policy-fixture.js';
import { createRegistryPolicyReader } from './registry-policy-read.js';

const id = (n: number) => `01J0P00000000000000000${String(n).padStart(4, '0')}`;

describe('registry policy snapshot reader', () => {
  let database: MigratedDatabase;
  let seed: Seed;
  const org = () => database.orgs!.a;
  const read = (
    query: Partial<Parameters<ReturnType<typeof createRegistryPolicyReader>['snapshot']>[1]> = {},
  ) =>
    createRegistryPolicyReader(database.executor).snapshot(org(), {
      ecosystem: 'npm',
      projectId: 'PROJECT',
      packageKey: 'left-pad',
      ...query,
    });

  beforeEach(async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    seed = seeder(database.executor);
    await seedProject(seed, 'PROJECT', org().orgId);
    await seedProject(seed, 'OTHER', org().orgId);
  });
  afterEach(() => database.close());

  it('keeps a zero-member block and reads members sorted per rule with the current epoch', async () => {
    await seedRule(seed, { id: id(1), orgId: org().orgId });
    await seedRule(seed, { id: id(2), orgId: org().orgId, kind: 'allowlist' });
    await seedMember(seed, org().orgId, id(2), '2.0.0');
    await seedMember(seed, org().orgId, id(2), '1.0.0');
    const [epoch] = await database.executor.all<{ version: string }>({
      sql: 'SELECT version FROM cache_epoch WHERE org_id = ?',
      params: [org().orgId],
    });
    const snapshot = await read();
    expect(snapshot.epoch).toBe(epoch!.version);
    expect(snapshot.rules.map((rule) => [rule.id, rule.kind, rule.members])).toEqual([
      [id(1), 'block', []],
      [id(2), 'allowlist', ['1.0.0', '2.0.0']],
    ]);
    expect(snapshot.rules[0]).toMatchObject({ denyUnknown: false, revision: 1, projectId: null });
  });

  it('reads organization and own-project rules, package-less rules and only the asked package', async () => {
    await seedRule(seed, { id: id(1), orgId: org().orgId, kind: 'min_age' });
    await seedRule(seed, { id: id(2), orgId: org().orgId, projectId: 'PROJECT' });
    await seedRule(seed, { id: id(3), orgId: org().orgId, projectId: 'OTHER' });
    await seedRule(seed, { id: id(4), orgId: org().orgId, packageKey: 'other' });
    await seedRule(seed, { id: id(5), orgId: org().orgId, disabled: true });
    await seedRule(seed, {
      id: id(6),
      orgId: org().orgId,
      ecosystem: 'composer',
      packageKey: 'vendor/pkg',
    });
    await seedRule(seed, { id: id(7), orgId: org().orgId, expiresAt: '2026-11-02T00:00:00.000Z' });
    expect((await read()).rules.map((rule) => rule.id)).toEqual([id(1), id(2), id(7)]);
    expect((await read({ packageKey: null })).rules.map((rule) => rule.id)).toEqual([id(1)]);
    expect(
      (await read({ ecosystem: 'composer', packageKey: 'vendor/pkg' })).rules.map(
        (rule) => rule.id,
      ),
    ).toEqual([id(6)]);
  });

  it('returns no facts for rules of another organization with colliding names and projects', async () => {
    const foreign = database.orgs!.b;
    await seedProject(seed, 'FOREIGN', foreign.orgId);
    await seedRule(seed, { id: id(1), orgId: foreign.orgId });
    await seedMember(seed, foreign.orgId, id(1), '1.0.0');
    await seedRule(seed, { id: id(2), orgId: foreign.orgId, projectId: 'FOREIGN' });
    expect((await read()).rules).toEqual([]);
    expect((await read({ projectId: 'FOREIGN' })).rules).toEqual([]);
  });

  it('fails closed above 256 applicable rules and without an epoch', async () => {
    for (let n = 1; n <= 256; n += 1) await seedRule(seed, { id: id(n), orgId: org().orgId });
    expect((await read()).rules).toHaveLength(256);
    await seedRule(seed, { id: id(257), orgId: org().orgId });
    await expect(read()).rejects.toBeInstanceOf(RegistryPolicyStoreError);
    await seed('DELETE FROM registry_policy_version');
    await seed('DELETE FROM registry_policy_rule');
    await seed('DELETE FROM cache_epoch WHERE org_id = ?', org().orgId);
    await expect(read()).rejects.toMatchObject({ message: 'Package policy is unavailable' });
  });

  it('refuses a malformed query before reading', async () => {
    await expect(read({ packageKey: 'Left-Pad' })).rejects.toThrow(TypeError);
    await expect(read({ projectId: '' })).rejects.toThrow(TypeError);
    await expect(read({ ecosystem: 'pypi' as never })).rejects.toThrow(TypeError);
  });

  it('reads organization rules only for a null project', async () => {
    await seedRule(seed, { id: id(1), orgId: org().orgId });
    await seedRule(seed, { id: id(2), orgId: org().orgId, projectId: 'PROJECT' });
    expect((await read({ projectId: null })).rules.map((rule) => rule.id)).toEqual([id(1)]);
    const namespace = await createRegistryPolicyReader(database.executor).namespace!(org(), {
      ecosystem: 'npm',
      projectId: null,
    });
    expect(namespace!.rules.map((rule) => rule.id)).toEqual([id(1)]);
  });
});

describe('registry policy namespace reader', () => {
  let database: MigratedDatabase;
  let seed: Seed;
  const org = () => database.orgs!.a;

  beforeEach(async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    seed = seeder(database.executor);
    await seedProject(seed, 'PROJECT', org().orgId);
    await seedProject(seed, 'OTHER', org().orgId);
  });
  afterEach(() => database.close());

  it('reads every package key in one batch and cuts the same per-package snapshots', async () => {
    await seedRule(seed, { id: id(1), orgId: org().orgId, kind: 'min_age' });
    await seedRule(seed, { id: id(2), orgId: org().orgId, projectId: 'PROJECT' });
    await seedRule(seed, { id: id(3), orgId: org().orgId, projectId: 'OTHER' });
    await seedRule(seed, { id: id(4), orgId: org().orgId, packageKey: 'other' });
    await seedRule(seed, { id: id(5), orgId: org().orgId, disabled: true });
    await seedRule(seed, { id: id(6), orgId: database.orgs!.b.orgId });
    await seedRule(seed, { id: id(7), orgId: org().orgId, kind: 'allowlist' });
    await seedMember(seed, org().orgId, id(7), '2.0.0');
    await seedMember(seed, org().orgId, id(7), '1.0.0');
    const batches: number[] = [];
    const counting = {
      ...database.executor,
      batch: (statements: Parameters<typeof database.executor.batch>[0]) => {
        batches.push(statements.length);
        return database.executor.batch(statements);
      },
    };
    const reader = createRegistryPolicyReader(counting);
    const namespace = await reader.namespace!(org(), { ecosystem: 'npm', projectId: 'PROJECT' });
    expect(batches).toEqual([3]);
    expect(namespace!.rules.map((rule) => [rule.id, rule.members])).toEqual([
      [id(1), []],
      [id(2), []],
      [id(4), []],
      [id(7), ['1.0.0', '2.0.0']],
    ]);
    for (const packageKey of [null, 'left-pad', 'other']) {
      expect(policyPackageView(namespace!, packageKey)).toEqual(
        await reader.snapshot(org(), { ecosystem: 'npm', projectId: 'PROJECT', packageKey }),
      );
    }
  });

  it('answers null above the namespace rule cap and fails closed without an epoch', async () => {
    const reader = createRegistryPolicyReader(database.executor);
    const query = { ecosystem: 'npm', projectId: 'PROJECT' } as const;
    for (let n = 1; n <= MAX_POLICY_NAMESPACE_RULES; n += 1) {
      await seedRule(seed, { id: id(n), orgId: org().orgId, packageKey: `p${String(n)}` });
    }
    expect((await reader.namespace!(org(), query))!.rules).toHaveLength(MAX_POLICY_NAMESPACE_RULES);
    await seedRule(seed, { id: id(9999), orgId: org().orgId, packageKey: 'last' });
    await expect(reader.namespace!(org(), query)).resolves.toBeNull();
    await seed('DELETE FROM registry_policy_rule');
    await seed('DELETE FROM cache_epoch WHERE org_id = ?', org().orgId);
    await expect(reader.namespace!(org(), query)).rejects.toBeInstanceOf(RegistryPolicyStoreError);
    await expect(reader.namespace!(org(), { ...query, projectId: '' })).rejects.toThrow(TypeError);
  });
});
