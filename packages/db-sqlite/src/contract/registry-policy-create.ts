import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { RegistryPolicyInputError } from '@package-broker/core/db/registry-policy';
import { ulid } from '@package-broker/core/ids';
import { ANCHORS } from '../testing/mutation-table/fixtures.js';
import { createRegistryPolicyStore } from '../repositories/registry-policy-create.js';
import { policyFixture, seedRule, type PolicyFixture } from './registry-policy-fixture.js';

const HASH = 'c'.repeat(64);

export function describeRegistryPolicyCreate(
  name: string,
  open: () => Promise<{ executor: SqlExecutor; close(): Promise<void> }>,
) {
  describe(`registry policy rule creation: ${name}`, () => {
    let database: Awaited<ReturnType<typeof open>>;
    let f: PolicyFixture;
    const store = (executor: SqlExecutor = database.executor) =>
      createRegistryPolicyStore(executor, ANCHORS);
    beforeEach(async () => {
      database = await open();
      f = await policyFixture(database.executor);
    });
    afterEach(() => database.close());

    async function unchanged(before: string | undefined) {
      expect(await f.count('registry_policy_rule')).toBe(0);
      expect(await f.count('registry_policy_version')).toBe(0);
      expect(await f.audits()).toEqual([]);
      expect(await f.epoch()).toBe(before);
    }

    it('commits the rule, its members, the audit event and a new epoch together', async () => {
      const before = await f.epoch();
      const foreignBefore = await f.epoch(f.orgs.b.orgId);
      const input = f.create({ members: ['2.0.0', '1.0.0'], incidentId: ulid() });
      expect(await store().create(f.org, f.decideFence, input)).toEqual({ ok: true, revision: 1 });
      expect(await f.rule(input.id)).toMatchObject({
        org_id: f.org.orgId,
        kind: 'block',
        package_key: 'left-pad',
        deny_unknown: 0,
        revision: 1,
        disabled_at: null,
      });
      expect(await f.members(input.id)).toEqual(['1.0.0', '2.0.0']);
      const [audit] = await f.audits();
      expect(audit).toMatchObject({
        action: 'registry_policy.create',
        target_id: input.id,
        project_id: null,
        actor_id: f.decider.userId,
      });
      expect(JSON.parse(audit!.payload_json)).toMatchObject({
        changes: {
          kind: { new: 'block' },
          member_count: { new: 2 },
          revision: { new: 1 },
        },
      });
      expect(await f.epoch()).not.toBe(before);
      expect(await f.epoch(f.orgs.b.orgId)).toBe(foreignBefore);
    });

    it('creates a zero-member block, an age rule, a client floor and a project rule', async () => {
      expect((await store().create(f.org, f.decideFence, f.create())).ok).toBe(true);
      expect(
        (
          await store().create(
            f.org,
            f.decideFence,
            f.create({ kind: 'min_age', packageKey: null, minAgeSeconds: 604800 }),
          )
        ).ok,
      ).toBe(true);
      expect(
        (
          await store().create(
            f.org,
            f.decideFence,
            f.create({
              kind: 'client_floor',
              packageKey: null,
              clientFamily: 'npm',
              clientMinVersion: '10.0.0',
              denyUnknown: true,
              reasonCode: 'compatibility',
            }),
          )
        ).ok,
      ).toBe(true);
      const project = f.create({ scope: { kind: 'project', projectId: 'PROJECT' } });
      expect(await store().create(f.org, f.requestFence, project)).toEqual({
        ok: true,
        revision: 1,
      });
      expect((await f.rule(project.id))?.['project_id']).toBe('PROJECT');
      expect(await f.count('registry_policy_rule')).toBe(4);
    });

    it('refuses a service token, a project manager on an organization rule and revoked authority without writes', async () => {
      const before = await f.epoch();
      expect(await store().create(f.org, f.tokenFence(), f.create())).toEqual({
        ok: false,
        reason: 'forbidden',
      });
      expect(await store().create(f.org, f.requestFence, f.create())).toEqual({
        ok: false,
        reason: 'forbidden',
      });
      await f.seed("DELETE FROM role_permission WHERE role_id = 'R-decider'");
      expect(await store().create(f.org, f.decideFence, f.create())).toEqual({
        ok: false,
        reason: 'forbidden',
      });
      await unchanged(before);
    });

    it('refuses a project rule for a project of another organization or one the actor does not manage', async () => {
      const before = await f.epoch();
      await f.seed(
        "INSERT INTO project (id, org_id, slug, name, status) VALUES ('FOREIGN', ?, 'foreign', 'Foreign', 'active')",
        f.orgs.b.orgId,
      );
      await f.seed(
        "INSERT INTO project (id, org_id, slug, name, status) VALUES ('SECOND', ?, 'second', 'Second', 'active')",
        f.org.orgId,
      );
      for (const projectId of ['FOREIGN', 'SECOND', 'MISSING']) {
        expect(
          await store().create(
            f.org,
            f.requestFence,
            f.create({ scope: { kind: 'project', projectId } }),
          ),
        ).toEqual({ ok: false, reason: 'forbidden' });
      }
      await unchanged(before);
    });

    it('loses authority revoked between the read and the batch', async () => {
      const before = await f.epoch();
      const executor = f.beforeBatch(() =>
        f.seed("DELETE FROM access_grant WHERE role_id = 'R-decider'"),
      );
      expect(await store(executor).create(f.org, f.decideFence, f.create())).toEqual({
        ok: false,
        reason: 'forbidden',
      });
      await unchanged(before);
    });

    it('rolls back the rule and members when the audit insert fails', async () => {
      const before = await f.epoch();
      const input = f.create({ members: ['1.0.0'] });
      await f.seed(
        "INSERT INTO audit_pending (id, org_id, created_at, actor_type, actor_id, action, target_type, target_id, payload_json) VALUES (?, ?, ?, 'system', NULL, 'setup.complete', 'organization', NULL, '{}')",
        input.audit.id,
        f.org.orgId,
        input.audit.occurredAt,
      );
      expect((await store().create(f.org, f.decideFence, input)).ok).toBe(false);
      expect(await f.count('registry_policy_rule')).toBe(0);
      expect(await f.count('registry_policy_version')).toBe(0);
      expect(await f.epoch()).toBe(before);
    });

    it('fails without writes when the organization epoch is missing', async () => {
      await f.seed('DELETE FROM cache_epoch WHERE org_id = ?', f.org.orgId);
      await expect(store().create(f.org, f.decideFence, f.create())).rejects.toThrow(
        'cache_epoch row is missing for the organization',
      );
      expect(await f.count('registry_policy_rule')).toBe(0);
      expect(await f.audits()).toEqual([]);
    });

    it('replays an idempotent create without a second rule or audit event', async () => {
      const now = new Date().toISOString();
      const record = {
        principalKey: `user:${f.decider.userId}`,
        key: 'create-1',
        route: 'POST /_pb/policies',
        requestHash: HASH,
        status: 201,
        responseJson: '{}',
        createdAt: now,
        expiresAt: new Date(Date.parse(now) + 86_400_000).toISOString(),
      };
      expect(
        (await store().create(f.org, f.decideFence, f.create({ idempotency: record }))).ok,
      ).toBe(true);
      const epoch = await f.epoch();
      expect(await store().create(f.org, f.decideFence, f.create({ idempotency: record }))).toEqual(
        {
          ok: false,
          reason: 'replayed',
        },
      );
      expect(await f.count('registry_policy_rule')).toBe(1);
      expect(await f.audits()).toHaveLength(1);
      expect(await f.epoch()).toBe(epoch);
    });

    it('lets an organization manager create a project rule and keeps a project manager to that project', async () => {
      await f.seed(
        "INSERT INTO project (id, org_id, slug, name, status) VALUES ('SECOND', ?, 'second', 'Second', 'active')",
        f.org.orgId,
      );
      const managed = f.create({ scope: { kind: 'project', projectId: 'SECOND' } });
      expect(await store().create(f.org, f.decideFence, managed)).toEqual({
        ok: true,
        revision: 1,
      });
      expect(await f.rule(managed.id)).toMatchObject({ project_id: 'SECOND', org_id: f.org.orgId });
      const floor = f.create({
        scope: { kind: 'project', projectId: 'SECOND' },
        kind: 'min_age',
        packageKey: null,
        minAgeSeconds: 60,
      });
      expect(await store().create(f.org, f.decideFence, floor)).toEqual({ ok: true, revision: 1 });
      expect(
        await store().create(
          f.org,
          f.requestFence,
          f.create({ scope: { kind: 'project', projectId: 'SECOND' } }),
        ),
      ).toEqual({ ok: false, reason: 'forbidden' });
      expect(await f.count('registry_policy_rule')).toBe(2);
    });

    it('refuses an organization manager on a project of another organization, an archived one or a missing one', async () => {
      const before = await f.epoch();
      await f.seed(
        "INSERT INTO project (id, org_id, slug, name, status) VALUES ('FOREIGN', ?, 'foreign', 'Foreign', 'active')",
        f.orgs.b.orgId,
      );
      await f.seed(
        "INSERT INTO project (id, org_id, slug, name, status) VALUES ('ARCHIVED', ?, 'archived', 'Archived', 'archived')",
        f.org.orgId,
      );
      for (const projectId of ['FOREIGN', 'ARCHIVED', 'MISSING']) {
        expect(
          await store().create(
            f.org,
            f.decideFence,
            f.create({ scope: { kind: 'project', projectId } }),
          ),
          projectId,
        ).toEqual({ ok: false, reason: 'forbidden' });
      }
      await unchanged(before);
    });

    it('answers a colliding id of the same organization as a conflict', async () => {
      const first = f.create();
      expect((await store().create(f.org, f.decideFence, first)).ok).toBe(true);
      expect(
        await store().create(f.org, f.decideFence, f.create({ id: first.id, packageKey: 'other' })),
      ).toEqual({ ok: false, reason: 'conflict' });
      expect(await f.count('registry_policy_rule')).toBe(1);
    });

    it('does not tell whether an id exists in another organization and leaves that rule untouched', async () => {
      const id = ulid();
      await seedRule(f.seed, { id, orgId: f.orgs.b.orgId, packageKey: 'foreign' });
      const foreignEpoch = await f.epoch(f.orgs.b.orgId);
      expect(await store().create(f.org, f.decideFence, f.create({ id }))).toEqual({
        ok: false,
        reason: 'indeterminate',
      });
      expect(await f.rule(id)).toMatchObject({ org_id: f.orgs.b.orgId, package_key: 'foreign' });
      expect(await f.count('registry_policy_rule')).toBe(0);
      expect(await f.audits()).toEqual([]);
      expect(await f.epoch(f.orgs.b.orgId)).toBe(foreignEpoch);
    });

    it('stores canonical Composer members exactly as version_normalized holds them', async () => {
      const input = f.create({
        ecosystem: 'composer',
        packageKey: 'acme/widget',
        members: ['1.0.0.0', '1.0.0.0-alpha1', 'dev-main'],
      });
      expect(await store().create(f.org, f.decideFence, input)).toEqual({ ok: true, revision: 1 });
      expect(await f.members(input.id)).toEqual(['1.0.0.0', '1.0.0.0-alpha1', 'dev-main']);
    });

    it('caps the rules one package read can see at 256', async () => {
      for (let n = 0; n < 255; n += 1) {
        await seedRule(f.seed, { id: ulid(), orgId: f.org.orgId });
      }
      await seedRule(f.seed, { id: ulid(), orgId: f.org.orgId, packageKey: 'other' });
      await seedRule(f.seed, { id: ulid(), orgId: f.orgs.b.orgId });
      expect((await store().create(f.org, f.decideFence, f.create())).ok).toBe(true);
      expect(await store().create(f.org, f.decideFence, f.create())).toEqual({
        ok: false,
        reason: 'limit_exceeded',
      });
      expect(
        await store().create(
          f.org,
          f.decideFence,
          f.create({ kind: 'min_age', packageKey: null, minAgeSeconds: 1 }),
        ),
      ).toEqual({ ok: false, reason: 'limit_exceeded' });
      expect(
        (await store().create(f.org, f.decideFence, f.create({ packageKey: 'other' }))).ok,
      ).toBe(true);
    });

    it.each<[string, Record<string, unknown>]>([
      ['id', { id: 'rule-1' }],
      ['packageKey', { packageKey: 'Left-Pad' }],
      ['packageKey', { packageKey: null }],
      ['members', { members: ['^1.0.0'] }],
      ['members', { members: Array.from({ length: 1001 }, (_, i) => `1.0.${i}`) }],
      ['members', { kind: 'quarantine', reasonCode: 'malware', members: [] }],
      [
        'scope',
        {
          kind: 'quarantine',
          reasonCode: 'malware',
          members: ['1.0.0'],
          scope: { kind: 'project', projectId: 'PROJECT' },
        },
      ],
      ['reasonCode', { reasonCode: 'because I said so' }],
      ['reasonCode', { kind: 'quarantine', members: ['1.0.0'] }],
      ['denyUnknown', { denyUnknown: true }],
      ['expiresAt', { expiresAt: '2000-01-01T00:00:00.000Z' }],
      [
        'clientFamily',
        {
          kind: 'client_floor',
          packageKey: null,
          clientFamily: 'composer',
          clientMinVersion: '2.0.0',
        },
      ],
      [
        'clientMinVersion',
        { kind: 'client_floor', packageKey: null, clientFamily: 'npm', clientMinVersion: '>=9' },
      ],
      ['minAgeSeconds', { kind: 'min_age', packageKey: null, minAgeSeconds: -1 }],
      ['incidentId', { incidentId: 'https://tracker.example/1' }],
      ['projectId', { scope: { kind: 'project', projectId: 'project one' } }],
      ['projectId', { scope: { kind: 'project', projectId: "x' OR 1=1" } }],
      ['projectId', { scope: { kind: 'project', projectId: '-leading' } }],
      ['projectId', { scope: { kind: 'project', projectId: 'p'.repeat(65) } }],
      ...['1.0', '1.0.0', '1.0.0.0-alpha.1', '1.0.0.0-beta-2'].map(
        (member): [string, Record<string, unknown>] => [
          'members',
          { ecosystem: 'composer', packageKey: 'acme/widget', members: [member] },
        ],
      ),
      ['audit', { audit: { id: 'x', occurredAt: 'now', context: {} } }],
    ])('refuses an invalid %s before any statement', async (field, overrides) => {
      let calls = 0;
      const counting: SqlExecutor = {
        driver: database.executor.driver,
        all: (statement) => {
          calls += 1;
          return database.executor.all(statement);
        },
        batch: (statements) => {
          calls += 1;
          return database.executor.batch(statements);
        },
      };
      const attempt = store(counting).create(f.org, f.decideFence, f.create(overrides as never));
      await expect(attempt).rejects.toBeInstanceOf(RegistryPolicyInputError);
      await expect(attempt).rejects.toMatchObject({ field, message: 'invalid_request' });
      expect(calls).toBe(0);
    });
  });
}
