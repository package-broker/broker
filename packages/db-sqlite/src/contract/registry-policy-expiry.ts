import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemMutationFence } from '@package-broker/core/authz/fence';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { RegistryPolicyInputError } from '@package-broker/core/db/registry-policy';
import { ulid } from '@package-broker/core/ids';
import { createRegistryPolicyCatalog } from '../repositories/registry-policy-catalog.js';
import { createRegistryPolicyExpiry } from '../repositories/registry-policy-expiry.js';
import { createRegistryPolicyReader } from '../repositories/registry-policy-read.js';
import { FUTURE } from '../testing/mutation-table/fixtures.js';
import {
  policyFixture,
  seedMember,
  seedRule,
  type PolicyFixture,
} from './registry-policy-fixture.js';

const PAST = '2026-11-01T12:00:00.000Z';
const LATER = '2099-06-01T00:00:00.000Z';
const JOB = { id: 'EXPIRY-JOB', owner: 'worker', fence: 3 };

export function describeRegistryPolicyExpiry(
  name: string,
  open: () => Promise<{ executor: SqlExecutor; close(): Promise<void> }>,
) {
  describe(`registry policy expiry bookkeeping and catalog: ${name}`, () => {
    let database: Awaited<ReturnType<typeof open>>;
    let f: PolicyFixture;
    const expiry = (executor: SqlExecutor = database.executor) =>
      createRegistryPolicyExpiry(executor);
    const fence = () => systemMutationFence('purge', JOB, {});
    beforeEach(async () => {
      database = await open();
      f = await policyFixture(database.executor);
      await f.seed(
        "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES (?, ?, 'core:registry-policy-expire:v1', ?, 'running', 'worker', ?, 3)",
        JOB.id,
        f.org.orgId,
        JOB.id,
        FUTURE,
      );
    });
    afterEach(() => database.close());

    const marker = async (id: string) => (await f.rule(id))?.['expiry_audited_at'];

    it('marks an expired rule once with one audit, without touching revision or epoch', async () => {
      const id = ulid();
      await seedRule(f.seed, { id, orgId: f.org.orgId, expiresAt: PAST, revision: 4 });
      const epoch = await f.epoch();
      expect((await expiry().due(f.org, 10)).map((row) => [row.id, row.revision])).toEqual([
        [id, 4],
      ]);
      expect(await expiry().mark(f.org, fence(), { id, revision: 4, audit: f.envelope() })).toBe(
        true,
      );
      expect(await expiry().mark(f.org, fence(), { id, revision: 4, audit: f.envelope() })).toBe(
        false,
      );
      expect(await expiry().due(f.org, 10)).toEqual([]);
      expect(await marker(id)).toEqual(expect.any(String));
      expect(await f.rule(id)).toMatchObject({ revision: 4, disabled_at: null });
      expect(await f.epoch()).toBe(epoch);
      const audits = await f.audits();
      expect(audits.map((row) => [row.action, row.target_id, row.actor_id])).toEqual([
        ['registry_policy.expire', id, 'registry-policy-expire'],
      ]);
      expect(JSON.parse(audits[0]!.payload_json)).toMatchObject({
        changes: {
          kind: { new: 'block' },
          expires_at: { new: PAST },
          revision: { new: 4 },
        },
      });
    });

    it('never marks a rule that has not expired, is disabled, or changed revision', async () => {
      const live = ulid();
      const disabled = ulid();
      const moved = ulid();
      await seedRule(f.seed, { id: live, orgId: f.org.orgId, expiresAt: LATER });
      await seedRule(f.seed, { id: disabled, orgId: f.org.orgId, expiresAt: PAST, disabled: true });
      await seedRule(f.seed, { id: moved, orgId: f.org.orgId, expiresAt: PAST, revision: 2 });
      expect((await expiry().due(f.org, 10)).map((row) => row.id)).toEqual([moved]);
      for (const [id, revision] of [
        [live, 1],
        [disabled, 1],
        [moved, 1],
      ] as const) {
        expect(await expiry().mark(f.org, fence(), { id, revision, audit: f.envelope() })).toBe(
          false,
        );
        expect(await marker(id)).toBeNull();
      }
      expect(await f.audits()).toEqual([]);
    });

    it('marks nothing when the rule changes between the read and the write', async () => {
      const id = ulid();
      await seedRule(f.seed, { id, orgId: f.org.orgId, expiresAt: PAST });
      const racing = f.beforeBatch(async () => {
        await f.seed('UPDATE registry_policy_rule SET revision = 2 WHERE id = ?', id);
      });
      expect(
        await expiry(racing).mark(f.org, fence(), { id, revision: 1, audit: f.envelope() }),
      ).toBe(false);
      expect(await marker(id)).toBeNull();
      expect(await f.audits()).toEqual([]);
    });

    it('leaves rules of another organization untouched', async () => {
      const foreign = ulid();
      await seedRule(f.seed, { id: foreign, orgId: f.orgs.b.orgId, expiresAt: PAST });
      expect(await expiry().due(f.org, 10)).toEqual([]);
      expect(
        await expiry().mark(f.org, fence(), { id: foreign, revision: 1, audit: f.envelope() }),
      ).toBe(false);
      expect(await marker(foreign)).toBeNull();
      expect(await f.count('audit_pending', f.orgs.b.orgId)).toBe(0);
    });

    it('rolls the marker back when the audit cannot be written', async () => {
      const id = ulid();
      await seedRule(f.seed, { id, orgId: f.org.orgId, expiresAt: PAST });
      const audit = f.envelope();
      await f.seed(
        "INSERT INTO audit_pending (id, org_id, created_at, actor_type, actor_id, action, target_type, target_id, payload_json) VALUES (?, ?, ?, 'system', 'x', 'registry_policy.expire', 'registry_policy', 'x', '{}')",
        audit.id,
        f.org.orgId,
        audit.occurredAt,
      );
      await expect(expiry().mark(f.org, fence(), { id, revision: 1, audit })).rejects.toThrow();
      expect(await marker(id)).toBeNull();
    });

    it('refuses a lease that is no longer held and any fence other than the purge job', async () => {
      const id = ulid();
      await seedRule(f.seed, { id, orgId: f.org.orgId, expiresAt: PAST });
      await f.seed("UPDATE job SET state = 'succeeded' WHERE id = ?", JOB.id);
      await expect(
        expiry().mark(f.org, fence(), { id, revision: 1, audit: f.envelope() }),
      ).rejects.toThrow();
      await expect(
        expiry().mark(f.org, f.decideFence, { id, revision: 1, audit: f.envelope() }),
      ).rejects.toBeInstanceOf(RegistryPolicyInputError);
      expect(await marker(id)).toBeNull();
      expect(await f.audits()).toEqual([]);
    });

    it('keeps an expired rule out of the snapshot whether or not it was marked', async () => {
      const id = ulid();
      await seedRule(f.seed, { id, orgId: f.org.orgId, expiresAt: PAST });
      const reader = createRegistryPolicyReader(database.executor);
      const before = await reader.snapshot(f.org, {
        ecosystem: 'npm',
        projectId: null,
        packageKey: 'left-pad',
      });
      expect(before.rules.map((rule) => [rule.id, rule.expiresAt])).toEqual([[id, PAST]]);
      await expiry().mark(f.org, fence(), { id, revision: 1, audit: f.envelope() });
      const after = await reader.snapshot(f.org, {
        ecosystem: 'npm',
        projectId: null,
        packageKey: 'left-pad',
      });
      expect(after).toEqual({ ...before, epoch: before.epoch });
    });

    it('lists rules by scope and kind with disabled rules and member counts', async () => {
      const block = ulid();
      const age = ulid();
      const project = ulid();
      const off = ulid();
      await seedRule(f.seed, { id: block, orgId: f.org.orgId });
      await seedMember(f.seed, f.org.orgId, block, '1.0.0');
      await seedMember(f.seed, f.org.orgId, block, '2.0.0');
      await seedRule(f.seed, { id: age, orgId: f.org.orgId, kind: 'min_age' });
      await seedRule(f.seed, { id: project, orgId: f.org.orgId, projectId: 'PROJECT' });
      await seedRule(f.seed, { id: off, orgId: f.org.orgId, disabled: true });
      const catalog = createRegistryPolicyCatalog(database.executor);
      const blocks = await catalog.list(f.org, { projectId: null, kinds: ['block'], limit: 10 });
      const expected = [
        [block, 2, null],
        [off, 0, 'false_positive'],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      expect(blocks.items.map((item) => [item.id, item.memberCount, item.disabledReason])).toEqual(
        expected,
      );
      expect((await catalog.list(f.org, { projectId: null, kinds: [], limit: 10 })).items).toEqual(
        [],
      );
      expect(
        (
          await catalog.list(f.org, { projectId: 'PROJECT', kinds: ['block'], limit: 10 })
        ).items.map((item) => item.id),
      ).toEqual([project]);
      const first = await catalog.list(f.org, {
        projectId: null,
        kinds: ['block', 'min_age'],
        limit: 1,
      });
      expect(first.items).toHaveLength(1);
      const second = await catalog.list(f.org, {
        projectId: null,
        kinds: ['block', 'min_age'],
        limit: 10,
        after: first.next!,
      });
      expect([...first.items, ...second.items].map((item) => item.id).sort()).toEqual(
        [block, age, off].sort(),
      );
      expect(await catalog.get(f.org, block)).toMatchObject({
        id: block,
        kind: 'block',
        memberCount: 2,
        members: ['1.0.0', '2.0.0'],
        denyUnknown: false,
      });
      expect(await catalog.get(f.org, 'not-a-ulid')).toBeNull();
    });
  });
}
