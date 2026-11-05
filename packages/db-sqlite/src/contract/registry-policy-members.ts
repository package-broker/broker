import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { RegistryPolicyInputError } from '@package-broker/core/db/registry-policy';
import { ulid } from '@package-broker/core/ids';
import { ANCHORS } from '../testing/mutation-table/fixtures.js';
import { createRegistryPolicyStore } from '../repositories/registry-policy-create.js';
import { createRegistryPolicyMembers } from '../repositories/registry-policy-members.js';
import { createRegistryPolicyUpdater } from '../repositories/registry-policy-update.js';
import {
  policyFixture,
  seedMember,
  seedRule,
  type PolicyFixture,
} from './registry-policy-fixture.js';

const versions = (count: number) => Array.from({ length: count }, (_, index) => `1.0.${index}`);

export function describeRegistryPolicyMembers(
  name: string,
  open: () => Promise<{ executor: SqlExecutor; close(): Promise<void> }>,
) {
  describe(`registry policy member replacement: ${name}`, () => {
    let database: Awaited<ReturnType<typeof open>>;
    let f: PolicyFixture;
    const members = (executor: SqlExecutor = database.executor) =>
      createRegistryPolicyMembers(executor, ANCHORS);
    beforeEach(async () => {
      database = await open();
      f = await policyFixture(database.executor);
    });
    afterEach(() => database.close());

    async function created(overrides: Parameters<PolicyFixture['create']>[0] = {}) {
      const input = f.create(overrides);
      expect(
        await createRegistryPolicyStore(database.executor, ANCHORS).create(
          f.org,
          f.decideFence,
          input,
        ),
      ).toEqual({ ok: true, revision: 1 });
      return input.id;
    }
    const replace = (
      id: string,
      list: readonly string[],
      extra: { expectedRevision?: number; overrideReason?: 'false_positive' | 'other' } = {},
    ) => ({
      id,
      expectedRevision: 1,
      members: list,
      now: new Date().toISOString(),
      audit: f.envelope(),
      ...extra,
    });
    async function frozen(id: string, run: () => Promise<unknown>) {
      const state = [await f.rule(id), await f.members(id), await f.audits(), await f.epoch()];
      await run();
      expect([await f.rule(id), await f.members(id), await f.audits(), await f.epoch()]).toEqual(
        state,
      );
    }

    it('replaces a block set atomically with revision, counts and epoch', async () => {
      const id = await created({ members: ['1.0.0', '1.0.1'] });
      const epoch = await f.epoch();
      expect(
        await members().replace(f.org, f.decideFence, replace(id, ['1.0.0', '1.0.1', '2.0.0'])),
      ).toEqual({
        ok: true,
        revision: 2,
      });
      expect(await f.members(id)).toEqual(['1.0.0', '1.0.1', '2.0.0']);
      expect(await f.rule(id)).toMatchObject({ revision: 2 });
      expect(await f.epoch()).not.toBe(epoch);
      const audit = (await f.audits()).at(-1)!;
      expect(audit.action).toBe('registry_policy.members_replace');
      expect(JSON.parse(audit.payload_json)).toEqual({
        op_id: expect.any(String),
        request_id: expect.any(String),
        changes: {
          kind: { new: 'block' },
          revision: { old: 1, new: 2 },
          member_count: { old: 2, new: 3 },
          members_added: { new: 1 },
          members_removed: { new: 0 },
        },
      });
    });

    it('fits 1,000 members within the D1 parameter bound and refuses 1,001', async () => {
      const id = await created();
      const seen: number[] = [];
      const counting: SqlExecutor = {
        driver: database.executor.driver,
        all: (statement) => {
          seen.push(statement.params.length);
          return database.executor.all(statement);
        },
        batch: (statements) => {
          for (const statement of statements) seen.push(statement.params.length);
          return database.executor.batch(statements);
        },
      };
      await f.reauth(f.decider);
      expect(
        await members(counting).replace(
          f.org,
          f.decideFence,
          replace(id, versions(1000), { overrideReason: 'other' }),
        ),
      ).toEqual({ ok: true, revision: 2 });
      expect(await f.count('registry_policy_version')).toBe(1000);
      expect(Math.max(...seen)).toBeLessThanOrEqual(100);
      await expect(
        members().replace(
          f.org,
          f.decideFence,
          replace(id, versions(1001), { expectedRevision: 2 }),
        ),
      ).rejects.toMatchObject({ field: 'members', message: 'invalid_request' });
      expect(await f.count('registry_policy_version')).toBe(1000);
    });

    it('empties a block without reauthentication and refuses an empty quarantine', async () => {
      const block = await created({ members: ['1.0.0'] });
      const quarantine = await created({
        kind: 'quarantine',
        reasonCode: 'malware',
        members: ['1.0.0'],
        packageKey: 'widget',
      });
      await f.reauth(f.decider);
      await expect(
        members().replace(
          f.org,
          f.decideFence,
          replace(quarantine, [], { overrideReason: 'other' }),
        ),
      ).rejects.toBeInstanceOf(RegistryPolicyInputError);
      await f.reauth(f.decider, 3600);
      expect(await members().replace(f.org, f.decideFence, replace(block, []))).toEqual({
        ok: true,
        revision: 2,
      });
      expect(await f.members(block)).toEqual([]);
      expect(await f.members(quarantine)).toEqual(['1.0.0']);
    });

    it('needs a reason and reauthentication for the first member of an empty block and for a removal', async () => {
      const id = await created();
      await expect(
        members().replace(f.org, f.decideFence, replace(id, ['1.0.0'])),
      ).rejects.toMatchObject({
        field: 'overrideReason',
      });
      await frozen(id, async () =>
        expect(
          await members().replace(
            f.org,
            f.decideFence,
            replace(id, ['1.0.0'], { overrideReason: 'false_positive' }),
          ),
        ).toEqual({ ok: false, reason: 'reauth_required' }),
      );
      await f.reauth(f.decider);
      expect(
        await members().replace(
          f.org,
          f.decideFence,
          replace(id, ['1.0.0', '1.0.1'], { overrideReason: 'false_positive' }),
        ),
      ).toEqual({ ok: true, revision: 2 });
      await f.reauth(f.decider, 3600);
      await expect(
        members().replace(f.org, f.decideFence, replace(id, ['1.0.0'], { expectedRevision: 2 })),
      ).rejects.toMatchObject({ field: 'overrideReason' });
      expect(
        await members().replace(
          f.org,
          f.decideFence,
          replace(id, ['1.0.0'], { expectedRevision: 2, overrideReason: 'other' }),
        ),
      ).toEqual({ ok: false, reason: 'reauth_required' });
      expect(JSON.parse((await f.audits()).at(-1)!.payload_json)).toMatchObject({
        changes: { override_reason: { new: 'false_positive' } },
      });
    });

    it('treats an empty allowlist as denying everything and an added version as weakening', async () => {
      const id = await created({ kind: 'allowlist', members: ['1.0.0'] });
      expect(await members().replace(f.org, f.decideFence, replace(id, []))).toEqual({
        ok: true,
        revision: 2,
      });
      expect(await f.members(id)).toEqual([]);
      expect(
        await members().replace(
          f.org,
          f.decideFence,
          replace(id, ['1.0.0'], { expectedRevision: 2 }),
        ),
      ).toEqual({ ok: false, reason: 'reauth_required' });
      await f.reauth(f.decider);
      expect(
        await members().replace(
          f.org,
          f.decideFence,
          replace(id, ['1.0.0'], { expectedRevision: 2 }),
        ),
      ).toEqual({ ok: true, revision: 3 });
    });

    it('keeps the old set, audit and epoch when the audit insert fails', async () => {
      const id = await created({ members: ['1.0.0'] });
      const input = replace(id, ['1.0.0', '2.0.0']);
      await f.seed(
        "INSERT INTO audit_pending (id, org_id, created_at, actor_type, actor_id, action, target_type, target_id, payload_json) VALUES (?, ?, ?, 'system', NULL, 'setup.complete', 'organization', NULL, '{}')",
        input.audit.id,
        f.org.orgId,
        input.audit.occurredAt,
      );
      const state = [await f.rule(id), await f.members(id), await f.epoch()];
      expect((await members().replace(f.org, f.decideFence, input)).ok).toBe(false);
      expect([await f.rule(id), await f.members(id), await f.epoch()]).toEqual(state);
    });

    it('refuses a service token and a revoked manager without writes', async () => {
      const id = await created({ members: ['1.0.0'] });
      await frozen(id, async () => {
        expect(
          await members().replace(f.org, f.tokenFence(), replace(id, ['1.0.0', '2.0.0'])),
        ).toEqual({
          ok: false,
          reason: 'forbidden',
        });
        await f.seed("DELETE FROM access_grant WHERE role_id = 'R-decider'");
        expect(
          await members().replace(f.org, f.decideFence, replace(id, ['1.0.0', '2.0.0'])),
        ).toEqual({
          ok: false,
          reason: 'forbidden',
        });
      });
    });

    it('cannot replace members of another organization rule', async () => {
      const id = ulid();
      await seedRule(f.seed, { id, orgId: f.orgs.b.orgId });
      await seedMember(f.seed, f.orgs.b.orgId, id, '9.9.9');
      await f.reauth(f.decider);
      expect(
        await members().replace(
          f.org,
          f.decideFence,
          replace(id, ['1.0.0'], { overrideReason: 'other' }),
        ),
      ).toEqual({ ok: false, reason: 'not_found' });
      expect(await f.members(id)).toEqual(['9.9.9']);
      expect(await f.count('registry_policy_version')).toBe(0);
    });

    it('lets one of two replacements from the same revision commit', async () => {
      const id = await created({ members: ['1.0.0'] });
      const racing = f.beforeBatch(async () => {
        expect(
          await members().replace(f.org, f.decideFence, replace(id, ['1.0.0', '3.0.0'])),
        ).toEqual({
          ok: true,
          revision: 2,
        });
      }, 2);
      expect(
        await members(racing).replace(f.org, f.decideFence, replace(id, ['1.0.0', '2.0.0'])),
      ).toEqual({
        ok: false,
        reason: 'conflict',
      });
      expect(await f.members(id)).toEqual(['1.0.0', '3.0.0']);
      expect(
        (await f.audits()).filter((row) => row.action === 'registry_policy.members_replace'),
      ).toHaveLength(1);
    });

    it('lets an organization manager replace project rule members and refuses a manager of another project', async () => {
      await f.seed(
        "INSERT INTO project (id, org_id, slug, name, status) VALUES ('SECOND', ?, 'second', 'Second', 'active')",
        f.org.orgId,
      );
      const own = ulid();
      const other = ulid();
      await seedRule(f.seed, { id: own, orgId: f.org.orgId, projectId: 'PROJECT' });
      await seedMember(f.seed, f.org.orgId, own, '1.0.0');
      await seedRule(f.seed, { id: other, orgId: f.org.orgId, projectId: 'SECOND' });
      await seedMember(f.seed, f.org.orgId, other, '1.0.0');
      await frozen(other, async () => {
        expect(
          await members().replace(f.org, f.requestFence, replace(other, ['1.0.0', '2.0.0'])),
        ).toEqual({ ok: false, reason: 'forbidden' });
      });
      expect(
        await members().replace(f.org, f.requestFence, replace(own, ['1.0.0', '2.0.0'])),
      ).toEqual({ ok: true, revision: 2 });
      expect(
        await members().replace(f.org, f.decideFence, replace(other, ['1.0.0', '3.0.0'])),
      ).toEqual({ ok: true, revision: 2 });
      expect(await f.members(other)).toEqual(['1.0.0', '3.0.0']);
    });

    it('answers a statement failure that left the revision in place as indeterminate', async () => {
      const id = ulid();
      await seedRule(f.seed, { id, orgId: f.org.orgId });
      await seedMember(f.seed, f.org.orgId, id, '1.0.0');
      await frozen(id, async () => {
        expect(
          await members().replace(f.org, f.decideFence, {
            ...replace(id, ['1.0.0', '2.0.0']),
            now: '2026-10-01T00:00:00.000Z',
          }),
        ).toEqual({ ok: false, reason: 'indeterminate' });
      });
    });

    it('refuses non-canonical Composer members before any statement and keeps canonical ones', async () => {
      const id = await created({
        ecosystem: 'composer',
        packageKey: 'acme/widget',
        members: ['1.0.0.0'],
      });
      for (const member of ['1.0', '1.0.0', '1.0.0.0-alpha.1', '1.0.0.0-beta-2']) {
        await expect(
          members().replace(f.org, f.decideFence, replace(id, ['1.0.0.0', member])),
        ).rejects.toMatchObject({ field: 'members', message: 'invalid_request' });
      }
      expect(
        await members().replace(
          f.org,
          f.decideFence,
          replace(id, ['1.0.0.0', '1.0.0.0-alpha1', 'dev-main']),
        ),
      ).toEqual({ ok: true, revision: 2 });
      expect(await f.members(id)).toEqual(['1.0.0.0', '1.0.0.0-alpha1', 'dev-main']);
    });

    it('refuses members on an age rule and on a disabled rule', async () => {
      const age = await created({ kind: 'min_age', packageKey: null, minAgeSeconds: 60 });
      await expect(members().replace(f.org, f.decideFence, replace(age, []))).rejects.toMatchObject(
        {
          field: 'members',
        },
      );
      const block = await created({ members: ['1.0.0'] });
      await f.reauth(f.decider);
      await createRegistryPolicyUpdater(database.executor, ANCHORS).disable(f.org, f.decideFence, {
        id: block,
        expectedRevision: 1,
        reason: 'superseded',
        now: new Date().toISOString(),
        audit: f.envelope(),
      });
      expect(
        await members().replace(
          f.org,
          f.decideFence,
          replace(block, ['1.0.0', '2.0.0'], { expectedRevision: 2 }),
        ),
      ).toEqual({ ok: false, reason: 'conflict' });
      expect(await f.members(block)).toEqual(['1.0.0']);
    });
  });
}
