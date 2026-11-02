import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { ANCHORS, seedVersion } from '../testing/mutation-table/fixtures.js';
import { createRegistryPolicyStore } from '../repositories/registry-policy-create.js';
import { createRegistryPolicyUpdater } from '../repositories/registry-policy-update.js';
import { policyFixture, seedRule, type PolicyFixture } from './registry-policy-fixture.js';

export function describeRegistryPolicyUpdate(
  name: string,
  open: () => Promise<{ executor: SqlExecutor; close(): Promise<void> }>,
) {
  describe(`registry policy rule update and disable: ${name}`, () => {
    let database: Awaited<ReturnType<typeof open>>;
    let f: PolicyFixture;
    const updater = (executor: SqlExecutor = database.executor) =>
      createRegistryPolicyUpdater(executor, ANCHORS);
    beforeEach(async () => {
      database = await open();
      f = await policyFixture(database.executor);
    });
    afterEach(() => database.close());

    async function created(
      overrides: Parameters<PolicyFixture['create']>[0] = {},
      fence = f.decideFence,
    ) {
      const input = f.create(overrides);
      expect(
        await createRegistryPolicyStore(database.executor, ANCHORS).create(f.org, fence, input),
      ).toEqual({
        ok: true,
        revision: 1,
      });
      return input.id;
    }
    const base = (id: string, expectedRevision = 1) => ({
      id,
      expectedRevision,
      now: new Date().toISOString(),
      audit: f.envelope(),
    });
    async function frozen(id: string, run: () => Promise<unknown>) {
      const rule = await f.rule(id);
      const audits = await f.audits();
      const epoch = await f.epoch();
      await run();
      expect(await f.rule(id)).toEqual(rule);
      expect(await f.audits()).toEqual(audits);
      expect(await f.epoch()).toBe(epoch);
    }
    const age = () => created({ kind: 'min_age', packageKey: null, minAgeSeconds: 604800 });

    it('tightens without reauthentication and records old and new revision and changed fields', async () => {
      const id = await age();
      const epoch = await f.epoch();
      expect(
        await updater().update(f.org, f.decideFence, {
          ...base(id),
          patch: { minAgeSeconds: 1209600 },
        }),
      ).toEqual({ ok: true, revision: 2 });
      expect(await f.rule(id)).toMatchObject({ min_age_seconds: 1209600, revision: 2 });
      expect(await f.epoch()).not.toBe(epoch);
      const audit = (await f.audits()).at(-1)!;
      expect(audit.action).toBe('registry_policy.update');
      expect(JSON.parse(audit.payload_json)).toEqual({
        op_id: expect.any(String),
        request_id: expect.any(String),
        changes: {
          min_age_seconds: { old: 604800, new: 1209600 },
          revision: { old: 1, new: 2 },
          changed_fields: { new: ['min_age_seconds'] },
        },
      });
    });

    it('refuses to weaken without a fresh reauthentication and accepts it after one', async () => {
      const id = await age();
      const weaken = () =>
        updater().update(f.org, f.decideFence, {
          ...base(id),
          patch: { minAgeSeconds: 3600 },
          overrideReason: 'emergency_compatibility',
        });
      await frozen(id, async () =>
        expect(await weaken()).toEqual({ ok: false, reason: 'reauth_required' }),
      );
      await f.reauth(f.decider, 601);
      await frozen(id, async () =>
        expect(await weaken()).toEqual({ ok: false, reason: 'reauth_required' }),
      );
      await f.reauth(f.decider);
      expect(await weaken()).toEqual({ ok: true, revision: 2 });
      expect(JSON.parse((await f.audits()).at(-1)!.payload_json)).toMatchObject({
        changes: { override_reason: { new: 'emergency_compatibility' } },
      });
    });

    it('treats an earlier expiry and a lower client floor as weakening', async () => {
      const block = await created({ expiresAt: '2099-01-01T00:00:00.000Z' });
      await frozen(block, async () =>
        expect(
          await updater().update(f.org, f.decideFence, {
            ...base(block),
            patch: { expiresAt: '2098-01-01T00:00:00.000Z' },
          }),
        ).toEqual({ ok: false, reason: 'reauth_required' }),
      );
      expect(
        await updater().update(f.org, f.decideFence, {
          ...base(block),
          patch: { expiresAt: null },
        }),
      ).toEqual({ ok: true, revision: 2 });
      const floor = await created({
        kind: 'client_floor',
        packageKey: null,
        clientFamily: 'npm',
        clientMinVersion: '10.0.0',
        denyUnknown: true,
        reasonCode: 'compatibility',
      });
      for (const patch of [{ clientMinVersion: '9.9.9' }, { denyUnknown: false }]) {
        expect(await updater().update(f.org, f.decideFence, { ...base(floor), patch })).toEqual({
          ok: false,
          reason: 'reauth_required',
        });
      }
      expect(
        await updater().update(f.org, f.decideFence, {
          ...base(floor),
          patch: { clientMinVersion: '11.0.0' },
        }),
      ).toEqual({ ok: true, revision: 2 });
    });

    it('refuses a stale revision, a disabled rule, a service token and a project manager on an organization rule', async () => {
      const id = await age();
      await f.reauth(f.decider);
      await f.reauth(f.requester);
      const patch = { minAgeSeconds: 1209600 };
      await frozen(id, async () => {
        expect(await updater().update(f.org, f.decideFence, { ...base(id, 2), patch })).toEqual({
          ok: false,
          reason: 'conflict',
        });
        expect(await updater().update(f.org, f.tokenFence(), { ...base(id), patch })).toEqual({
          ok: false,
          reason: 'forbidden',
        });
        expect(
          await updater().disable(f.org, f.tokenFence(), { ...base(id), reason: 'other' }),
        ).toEqual({ ok: false, reason: 'forbidden' });
        expect(await updater().update(f.org, f.requestFence, { ...base(id), patch })).toEqual({
          ok: false,
          reason: 'forbidden',
        });
      });
      expect(
        await updater().disable(f.org, f.decideFence, { ...base(id), reason: 'superseded' }),
      ).toEqual({
        ok: true,
        revision: 2,
      });
      expect(await updater().update(f.org, f.decideFence, { ...base(id, 2), patch })).toEqual({
        ok: false,
        reason: 'conflict',
      });
    });

    it('reports a stale revision as a conflict before asking for reauthentication', async () => {
      const id = await age();
      await f.seed('UPDATE registry_policy_rule SET revision = 2 WHERE id = ?', id);
      await frozen(id, async () => {
        expect(
          await updater().update(f.org, f.decideFence, {
            ...base(id),
            patch: { minAgeSeconds: 1 },
          }),
        ).toEqual({ ok: false, reason: 'conflict' });
        expect(
          await updater().disable(f.org, f.decideFence, { ...base(id), reason: 'other' }),
        ).toEqual({
          ok: false,
          reason: 'conflict',
        });
      });
    });

    it('lets a project manager edit only that project rule', async () => {
      const id = await created(
        { scope: { kind: 'project', projectId: 'PROJECT' } },
        f.requestFence,
      );
      expect(
        await updater().update(f.org, f.requestFence, {
          ...base(id),
          patch: { reasonCode: 'organization_policy' },
        }),
      ).toEqual({ ok: true, revision: 2 });
      await f.seed("DELETE FROM access_grant WHERE role_id = 'R-requester'");
      expect(
        await updater().update(f.org, f.requestFence, {
          ...base(id, 2),
          patch: { incidentId: ulid() },
        }),
      ).toEqual({ ok: false, reason: 'forbidden' });
    });

    it('disables with reauthentication, a fixed reason, audit and epoch in one commit', async () => {
      const id = await created({ members: ['1.0.0'] });
      expect(
        await updater().disable(f.org, f.decideFence, { ...base(id), reason: 'false_positive' }),
      ).toEqual({
        ok: false,
        reason: 'reauth_required',
      });
      await f.reauth(f.decider);
      const epoch = await f.epoch();
      expect(
        await updater().disable(f.org, f.decideFence, { ...base(id), reason: 'false_positive' }),
      ).toEqual({
        ok: true,
        revision: 2,
      });
      expect(await f.rule(id)).toMatchObject({ disabled_reason: 'false_positive', revision: 2 });
      expect((await f.rule(id))?.['disabled_at']).not.toBeNull();
      expect(await f.members(id)).toEqual(['1.0.0']);
      expect(await f.epoch()).not.toBe(epoch);
      const audit = (await f.audits()).at(-1)!;
      expect(audit.action).toBe('registry_policy.disable');
      expect(JSON.parse(audit.payload_json)).toMatchObject({
        changes: {
          override_reason: { new: 'false_positive' },
          revision: { old: 1, new: 2 },
        },
      });
    });

    it('rolls back a disable whose audit insert fails', async () => {
      const id = await created();
      await f.reauth(f.decider);
      const input = { ...base(id), reason: 'other' as const };
      await f.seed(
        "INSERT INTO audit_pending (id, org_id, created_at, actor_type, actor_id, action, target_type, target_id, payload_json) VALUES (?, ?, ?, 'system', NULL, 'setup.complete', 'organization', NULL, '{}')",
        input.audit.id,
        f.org.orgId,
        input.audit.occurredAt,
      );
      const rule = await f.rule(id);
      const epoch = await f.epoch();
      expect((await updater().disable(f.org, f.decideFence, input)).ok).toBe(false);
      expect(await f.rule(id)).toEqual(rule);
      expect(await f.epoch()).toBe(epoch);
    });

    it('lets only one of two concurrent edits from the same revision commit', async () => {
      const id = await age();
      const racing = f.beforeBatch(async () => {
        expect(
          await updater().update(f.org, f.decideFence, {
            ...base(id),
            patch: { minAgeSeconds: 1209600 },
          }),
        ).toEqual({ ok: true, revision: 2 });
      });
      expect(
        await updater(racing).update(f.org, f.decideFence, {
          ...base(id),
          patch: { minAgeSeconds: 2419200 },
        }),
      ).toEqual({ ok: false, reason: 'conflict' });
      expect(await f.rule(id)).toMatchObject({ min_age_seconds: 1209600, revision: 2 });
      expect(
        (await f.audits()).filter((row) => row.action === 'registry_policy.update'),
      ).toHaveLength(1);
    });

    it('clears the expiry marker only when the expiry is edited', async () => {
      const id = await created({ expiresAt: '2098-01-01T00:00:00.000Z' });
      await f.seed(
        "UPDATE registry_policy_rule SET expiry_audited_at = '2026-11-01T00:00:00.000Z' WHERE id = ?",
        id,
      );
      await updater().update(f.org, f.decideFence, { ...base(id), patch: { incidentId: ulid() } });
      expect((await f.rule(id))?.['expiry_audited_at']).toBe('2026-11-01T00:00:00.000Z');
      await updater().update(f.org, f.decideFence, {
        ...base(id, 2),
        patch: { expiresAt: '2099-01-01T00:00:00.000Z' },
      });
      expect(await f.rule(id)).toMatchObject({ expiry_audited_at: null, revision: 3 });
    });

    it('releases a malware quarantine without touching version status, publish holds or other rules', async () => {
      await seedVersion(f.seed, 'V-HELD', f.org.orgId, 'PACKAGE', '1.0.0');
      await f.seed("UPDATE version SET status = 'quarantined' WHERE id = 'V-HELD'");
      const quarantine = await created({
        kind: 'quarantine',
        packageKey: 'widget',
        reasonCode: 'malware',
        members: ['1.0.0'],
      });
      const block = await created({ packageKey: 'widget', members: ['1.0.0'] });
      await f.reauth(f.decider);
      expect(
        await updater().disable(f.org, f.decideFence, {
          ...base(quarantine),
          reason: 'false_positive',
        }),
      ).toEqual({
        ok: true,
        revision: 2,
      });
      expect((await f.audits()).at(-1)?.action).toBe('registry_policy.release');
      expect(
        await database.executor.all({
          sql: "SELECT status FROM version WHERE id = 'V-HELD'",
          params: [],
        }),
      ).toEqual([{ status: 'quarantined' }]);
      expect(await f.rule(block)).toMatchObject({ disabled_at: null, revision: 1 });
      expect(await f.members(block)).toEqual(['1.0.0']);
    });

    it('finds no rule of another organization and leaves it untouched', async () => {
      const id = ulid();
      await seedRule(f.seed, { id, orgId: f.orgs.b.orgId, kind: 'min_age', packageKey: null });
      const foreignEpoch = await f.epoch(f.orgs.b.orgId);
      await f.reauth(f.decider);
      expect(
        await updater().update(f.org, f.decideFence, { ...base(id), patch: { minAgeSeconds: 1 } }),
      ).toEqual({ ok: false, reason: 'not_found' });
      expect(
        await updater().disable(f.org, f.decideFence, { ...base(id), reason: 'other' }),
      ).toEqual({
        ok: false,
        reason: 'not_found',
      });
      expect(await f.rule(id)).toMatchObject({
        org_id: f.orgs.b.orgId,
        min_age_seconds: 86400,
        disabled_at: null,
      });
      expect(await f.epoch(f.orgs.b.orgId)).toBe(foreignEpoch);
    });

    it('lets an organization manager edit a project rule and refuses a manager of another project', async () => {
      await f.seed(
        "INSERT INTO project (id, org_id, slug, name, status) VALUES ('SECOND', ?, 'second', 'Second', 'active')",
        f.org.orgId,
      );
      const own = ulid();
      const other = ulid();
      await seedRule(f.seed, { id: own, orgId: f.org.orgId, projectId: 'PROJECT' });
      await seedRule(f.seed, { id: other, orgId: f.org.orgId, projectId: 'SECOND' });
      await f.reauth(f.requester);
      const patch = { reasonCode: 'organization_policy' } as const;
      await frozen(other, async () => {
        expect(await updater().update(f.org, f.requestFence, { ...base(other), patch })).toEqual({
          ok: false,
          reason: 'forbidden',
        });
        expect(
          await updater().disable(f.org, f.requestFence, { ...base(other), reason: 'other' }),
        ).toEqual({ ok: false, reason: 'forbidden' });
      });
      expect(await updater().update(f.org, f.decideFence, { ...base(own), patch })).toEqual({
        ok: true,
        revision: 2,
      });
      await f.reauth(f.decider);
      expect(
        await updater().disable(f.org, f.decideFence, { ...base(other), reason: 'superseded' }),
      ).toEqual({ ok: true, revision: 2 });
      const age = ulid();
      await seedRule(f.seed, {
        id: age,
        orgId: f.org.orgId,
        projectId: 'SECOND',
        kind: 'min_age',
        packageKey: null,
      });
      expect(
        await updater().update(f.org, f.decideFence, {
          ...base(age),
          patch: { minAgeSeconds: 172800 },
        }),
      ).toEqual({ ok: true, revision: 2 });
    });

    it('answers a statement failure that left the revision in place as indeterminate', async () => {
      const id = ulid();
      await seedRule(f.seed, { id, orgId: f.org.orgId, kind: 'min_age', packageKey: null });
      await frozen(id, async () => {
        expect(
          await updater().update(f.org, f.decideFence, {
            ...base(id),
            now: '2026-10-01T00:00:00.000Z',
            patch: { minAgeSeconds: 172800 },
          }),
        ).toEqual({ ok: false, reason: 'indeterminate' });
      });
    });

    it('answers a patch that changes nothing with the current revision and writes nothing', async () => {
      const id = await age();
      await frozen(id, async () => {
        expect(
          await updater().update(f.org, f.decideFence, {
            ...base(id),
            patch: { minAgeSeconds: 604800, incidentId: null, expiresAt: null },
          }),
        ).toEqual({ ok: true, revision: 1, unchanged: true });
        expect(
          await updater().update(f.org, f.requestFence, {
            ...base(id),
            patch: { minAgeSeconds: 604800 },
          }),
        ).toEqual({ ok: false, reason: 'forbidden' });
      });
      expect(
        await updater().update(f.org, f.decideFence, {
          ...base(id),
          patch: { minAgeSeconds: 604800, reasonCode: 'compatibility' },
        }),
      ).toEqual({ ok: true, revision: 2 });
      expect(JSON.parse((await f.audits()).at(-1)!.payload_json)).toMatchObject({
        changes: { changed_fields: { new: ['reason_code'] } },
      });
    });

    it('refuses a malformed audit envelope as input even when the patch changes nothing', async () => {
      const id = await age();
      const good = f.envelope();
      await frozen(id, async () => {
        for (const audit of [
          { ...good, id: 'not-a-ulid' },
          { ...good, occurredAt: 'yesterday' },
          { ...good, context: { ...good.context, requestId: 'x'.repeat(10_000) } },
          null,
        ]) {
          await expect(
            updater().update(f.org, f.decideFence, {
              ...base(id),
              audit: audit as never,
              patch: { minAgeSeconds: 604800 },
            }),
          ).rejects.toMatchObject({ field: 'audit', message: 'invalid_request' });
        }
      });
    });

    it('refuses the wrong organization permission kind on a project rule', async () => {
      const age = ulid();
      const block = ulid();
      await seedRule(f.seed, {
        id: age,
        orgId: f.org.orgId,
        projectId: 'PROJECT',
        kind: 'min_age',
        packageKey: null,
      });
      await seedRule(f.seed, { id: block, orgId: f.org.orgId, projectId: 'PROJECT' });
      await f.seed(
        "DELETE FROM role_permission WHERE org_id = ? AND role_id = 'R-decider' AND permission = 'org:settings:write'",
        f.org.orgId,
      );
      await frozen(age, async () => {
        expect(
          await updater().update(f.org, f.decideFence, {
            ...base(age),
            patch: { minAgeSeconds: 172800 },
          }),
        ).toEqual({ ok: false, reason: 'forbidden' });
      });
      expect(
        await updater().update(f.org, f.decideFence, {
          ...base(block),
          patch: { reasonCode: 'organization_policy' },
        }),
      ).toEqual({ ok: true, revision: 2 });
      await f.seed(
        "UPDATE role_permission SET permission = 'org:settings:write' WHERE org_id = ? AND role_id = 'R-decider' AND permission = 'org:packages:manage'",
        f.org.orgId,
      );
      await frozen(block, async () => {
        expect(
          await updater().update(f.org, f.decideFence, {
            ...base(block, 2),
            patch: { reasonCode: 'compatibility' },
          }),
        ).toEqual({ ok: false, reason: 'forbidden' });
      });
      expect(
        await updater().update(f.org, f.decideFence, {
          ...base(age),
          patch: { minAgeSeconds: 172800 },
        }),
      ).toEqual({ ok: true, revision: 2 });
    });

    it('refuses an unknown override reason and patch fields that do not fit the kind', async () => {
      const id = await age();
      await expect(
        updater().disable(f.org, f.decideFence, { ...base(id), reason: 'because' as never }),
      ).rejects.toMatchObject({ field: 'overrideReason', message: 'invalid_request' });
      for (const [patch, field] of [
        [{ clientMinVersion: '10.0.0' }, 'clientMinVersion'],
        [{ minAgeSeconds: -5 }, 'minAgeSeconds'],
        [{ packageKey: 'other' }, 'patch'],
        [{}, 'patch'],
      ] as const) {
        await expect(
          updater().update(f.org, f.decideFence, { ...base(id), patch: patch as never }),
        ).rejects.toMatchObject({ field, message: 'invalid_request' });
      }
      expect(await f.rule(id)).toMatchObject({ revision: 1 });
    });
  });
}
