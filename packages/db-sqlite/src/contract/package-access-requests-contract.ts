import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { systemMutationFence } from '@package-broker/core/authz/fence';
import { accessFixture } from './package-access-requests-fixture.js';

export function describePackageAccessRequests(
  name: string,
  open: () => Promise<{ executor: SqlExecutor; close(): Promise<void> }>,
) {
  describe(`package access requests: ${name}`, () => {
    let database: Awaited<ReturnType<typeof open>>;
    let f: Awaited<ReturnType<typeof accessFixture>>;
    beforeEach(async () => {
      database = await open();
      f = await accessFixture(database.executor);
    });
    afterEach(async () => {
      await database.close();
    });
    const rows = (sql: string) => database.executor.all({ sql, params: [] });
    async function create() {
      return f.repo.request(f.org, f.requestFence, f.input());
    }
    async function decide(
      id: string,
      state: 'approved' | 'rejected' = 'approved',
      expectedRevision = 1,
    ) {
      return f.repo.decide(f.org, f.decideFence, {
        id,
        state,
        expectedRevision,
        decidedByUserId: f.decider.userId,
        now: f.now,
        event: f.event('package.access_decide'),
      });
    }
    it('creates a pending request and one audit row without granting access', async () => {
      const request = await create();
      expect(request.state).toBe('pending');
      expect(request.revision).toBe(1);
      expect(await f.repo.get(f.org, request.id)).toMatchObject({
        id: request.id,
        packageId: 'PACKAGE',
      });
      expect(await rows('SELECT id FROM audit_pending')).toHaveLength(1);
      expect(await rows('SELECT package_id FROM project_package')).toEqual([]);
    });
    it('exports sanitized display names without account or identity emails', async () => {
      const a = await create();
      await f.seed(
        "UPDATE user_account SET display_name = 'Requester' WHERE id = ?",
        f.requester.userId,
      );
      expect((await f.repo.get(f.org, a.id))?.requestedBy.name).toBe('Requester');
      await f.seed('UPDATE user_account SET display_name = email WHERE id = ?', f.requester.userId);
      const text = JSON.stringify(await f.repo.get(f.org, a.id));
      expect(text).not.toContain('requester@example.test');
      expect(text).not.toContain('decider@example.test');
      expect(text).not.toContain('email');
    });
    it('lists only the organization and state with bounded cursor pages', async () => {
      const a = await create();
      await decide(a.id, 'rejected');
      const b = await create();
      expect(
        (await f.repo.list(f.org, { state: 'pending', limit: 1 })).items.map((x) => x.id),
      ).toEqual([b.id]);
      const page = await f.repo.list(f.org, { limit: 1 });
      expect(page.items).toHaveLength(1);
      expect(page.next).not.toBeNull();
      expect((await f.repo.list(f.org, { limit: 1, cursor: page.next! })).items).toHaveLength(1);
      expect(await f.repo.get(f.orgs.b, a.id)).toBeNull();
      expect((await f.repo.list(f.orgs.b, { limit: 50 })).items).toEqual([]);
    });
    it.each([
      ['visible_to_new_projects = 1'],
      ["new_project_access_mode = 'none'"],
      ['held_until_active = 1'],
      ["status = 'removed_upstream'"],
    ])('refuses non-requestable packages: %s', async (change) => {
      await f.seed(`UPDATE package SET ${change}`);
      await expect(create()).rejects.toMatchObject({ code: 'conflict' });
      expect(await rows('SELECT id FROM audit_pending')).toEqual([]);
    });
    it('refuses a duplicate pending request and allows another after rejection', async () => {
      const a = await create();
      await expect(create()).rejects.toMatchObject({ code: 'conflict' });
      await decide(a.id, 'rejected');
      expect((await create()).state).toBe('pending');
      expect(await rows('SELECT id FROM audit_pending')).toHaveLength(3);
    });
    it('rechecks request authority and archive state inside the batch', async () => {
      await f.seed("DELETE FROM role_permission WHERE role_id = 'R-requester'");
      await expect(create()).rejects.toMatchObject({ code: 'forbidden' });
      expect(await rows('SELECT id FROM package_access_request')).toEqual([]);
    });
    it('refuses requests and requestable listings for an archived project', async () => {
      await f.seed("UPDATE project SET status = 'archived'");
      await expect(create()).rejects.toMatchObject({ code: 'conflict' });
      expect((await f.repo.requestable(f.org, 'PROJECT', { limit: 50 })).items).toEqual([]);
    });
    it('does not request a foreign package or project', async () => {
      const input = f.input();
      await expect(f.repo.request(f.orgs.b, f.requestFence, input)).rejects.toMatchObject({
        code: 'forbidden',
      });
      expect(await rows('SELECT id FROM package_access_request')).toEqual([]);
    });
    it('approves once with explicit membership, representation revision and audit in one batch', async () => {
      const a = await create();
      const before = await rows('SELECT rev FROM package');
      expect(await decide(a.id)).toEqual({ changed: true, revision: 2 });
      expect(await rows('SELECT package_id, origin FROM project_package')).toEqual([
        { package_id: 'PACKAGE', origin: 'explicit' },
      ]);
      expect(await rows('SELECT rev FROM package')).not.toEqual(before);
      expect(await decide(a.id, 'rejected', 2)).toEqual({ changed: false, revision: 2 });
      expect(await rows('SELECT id FROM audit_pending')).toHaveLength(2);
    });
    it('rejects without membership and stale revisions change nothing', async () => {
      const a = await create();
      expect(await decide(a.id, 'approved', 2)).toEqual({ changed: false, revision: 1 });
      expect(await decide(a.id, 'rejected')).toEqual({ changed: true, revision: 2 });
      expect(await rows('SELECT package_id FROM project_package')).toEqual([]);
    });
    it('checks authority before revealing whether a decision row exists', async () => {
      await f.seed("DELETE FROM role_permission WHERE role_id = 'R-decider'");
      await expect(decide('missing')).rejects.toMatchObject({ code: 'forbidden' });
    });
    it('audits package names on requests', async () => {
      await create();
      const audit = await rows('SELECT payload_json FROM audit_pending');
      expect(JSON.parse(String(audit[0]?.payload_json))).toMatchObject({
        changes: { package: { new: 'widget' } },
      });
    });
    it('rechecks decision authority and refuses forged decision actors', async () => {
      const a = await create();
      await expect(
        f.repo.decide(f.org, f.decideFence, {
          id: a.id,
          state: 'approved',
          expectedRevision: 1,
          decidedByUserId: f.requester.userId,
          now: f.now,
          event: f.event('package.access_decide'),
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      await f.seed("DELETE FROM role_permission WHERE role_id = 'R-decider'");
      await expect(decide(a.id)).rejects.toMatchObject({ code: 'forbidden' });
      expect(await rows('SELECT id FROM audit_pending')).toHaveLength(1);
    });
    it('cannot approve an expired request or grant access to an archived project', async () => {
      const a = await create();
      await f.seed("UPDATE package_access_request SET expires_at = '2000-01-01T00:00:00.000Z'");
      expect((await decide(a.id)).changed).toBe(false);
      await f.seed("UPDATE package_access_request SET expires_at = '2099-01-01T00:00:00.000Z'");
      await f.seed("UPDATE project SET status = 'archived'");
      expect((await decide(a.id)).changed).toBe(false);
      expect(await rows('SELECT package_id FROM project_package')).toEqual([]);
    });
    it('lists requestable packages only when inaccessible, active, attached and unheld', async () => {
      expect((await f.repo.requestable(f.org, 'PROJECT', { limit: 50 })).items).toEqual([
        { id: 'PACKAGE', name: 'widget', newProjectAccessMode: 'request' },
      ]);
      const a = await create();
      await decide(a.id);
      expect((await f.repo.requestable(f.org, 'PROJECT', { limit: 50 })).items).toEqual([]);
      expect((await f.repo.requestable(f.orgs.b, 'PROJECT', { limit: 50 })).items).toEqual([]);
    });
    it('advances the representation clock monotonically when approval stamps are older', async () => {
      const a = await create();
      await f.seed("UPDATE package SET modified_at = '2099-01-01T00:00:00.000Z'");
      await decide(a.id);
      const clock = await rows('SELECT modified_at FROM package');
      expect(String(clock[0]?.modified_at) > '2099-01-01T00:00:00.000Z').toBe(true);
    });
    it('rolls back the decision and membership when its audit insert cannot commit', async () => {
      const a = await create();
      const existing = await rows('SELECT id FROM audit_pending');
      await expect(
        f.repo.decide(f.org, f.decideFence, {
          id: a.id,
          state: 'approved',
          expectedRevision: 1,
          decidedByUserId: f.decider.userId,
          now: f.now,
          event: { ...f.event('package.access_decide'), id: String(existing[0]?.id) },
        }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect((await f.repo.get(f.org, a.id))?.state).toBe('pending');
      expect(await rows('SELECT package_id FROM project_package')).toEqual([]);
      expect(await rows('SELECT id FROM audit_pending')).toHaveLength(1);
    });
    it.each(['source', 'attachment'])(
      'refuses requestability and requests for an unavailable %s',
      async (layer) => {
        if (layer === 'source') await f.seed("UPDATE source SET status = 'paused'");
        else await f.seed('DELETE FROM project_source');
        expect((await f.repo.requestable(f.org, 'PROJECT', { limit: 50 })).items).toEqual([]);
        await expect(create()).rejects.toMatchObject({
          code: layer === 'attachment' ? 'source_not_attached' : 'conflict',
        });
      },
    );
    it('bounds due batches to ten pending rows and excludes another organization', async () => {
      const a = await create();
      for (let i = 0; i < 11; i++) {
        const id = `PROJECT${i}`;
        await f.seed(
          'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
          id,
          f.org.orgId,
          id.toLowerCase(),
          id,
        );
        await f.seed(
          "INSERT INTO package_access_request (id, org_id, package_id, project_id, requested_by_user_id, expires_at) VALUES (?, ?, 'PACKAGE', ?, ?, '2000-01-01T00:00:00.000Z')",
          `REQ${i}`,
          f.org.orgId,
          id,
          f.requester.userId,
        );
      }
      expect(await f.repo.due(f.org)).toHaveLength(10);
      expect(await f.repo.due(f.orgs.b)).toEqual([]);
      expect((await f.repo.due(f.org)).map((x) => x.id)).not.toContain(a.id);
    });
    it('refuses invalid pagination, byte-sized reasons and forged expiry durations', async () => {
      await expect(f.repo.list(f.org, { limit: 51 })).rejects.toMatchObject({
        code: 'invalid_request',
      });
      await expect(f.repo.requestable(f.org, 'PROJECT', { limit: 0 })).rejects.toMatchObject({
        code: 'invalid_request',
      });
      await expect(
        f.repo.request(f.org, f.requestFence, { ...f.input(), reason: 'é'.repeat(501) }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(
        f.repo.request(f.org, f.requestFence, {
          ...f.input(),
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(await rows('SELECT id FROM audit_pending')).toEqual([]);
    });
    it('expires only due pending rows with a live job lease, CAS and audit', async () => {
      const a = await create();
      await f.seed(
        "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES ('JOB', ?, 'core:package-access-expire:v1', 'expire', 'running', 'OWNER', '2099-01-01T00:00:00.000Z', 1)",
        f.org.orgId,
      );
      const fence = systemMutationFence('purge', { id: 'JOB', owner: 'OWNER', fence: 1 }, {});
      const input = {
        id: a.id,
        state: 'expired' as const,
        expectedRevision: 1,
        decidedByUserId: null,
        now: f.now,
        event: f.event('package.access_decide', true),
      };
      expect(await f.repo.due(f.org)).toEqual([]);
      expect((await f.repo.decide(f.org, fence, input)).changed).toBe(false);
      await f.seed("UPDATE package_access_request SET expires_at = '2000-01-01T00:00:00.000Z'");
      expect(await f.repo.due(f.org)).toHaveLength(1);
      expect((await f.repo.decide(f.org, fence, input)).changed).toBe(true);
      expect((await f.repo.get(f.org, a.id))?.state).toBe('expired');
      expect((await f.repo.decide(f.org, fence, input)).changed).toBe(false);
      expect(await rows('SELECT id FROM audit_pending')).toHaveLength(2);
      expect(await rows('SELECT package_id FROM project_package')).toEqual([]);
    });
    it.each(['owner', 'fence', 'until', 'state', 'org', 'id', 'writer'] as const)(
      'refuses expiry with a mismatched lease %s',
      async (mismatch) => {
        const a = await create();
        await f.seed("UPDATE package_access_request SET expires_at = '2000-01-01T00:00:00.000Z'");
        await f.seed(
          "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES ('JOB', ?, 'core:package-access-expire:v1', 'expire', 'running', 'OWNER', '2099-01-01T00:00:00.000Z', 1)",
          mismatch === 'org' ? f.orgs.b.orgId : f.org.orgId,
        );
        if (mismatch === 'until')
          await f.seed("UPDATE job SET lease_until = '2000-01-01T00:00:00.000Z'");
        if (mismatch === 'state') await f.seed("UPDATE job SET state = 'queued'");
        const fence = systemMutationFence(
          mismatch === 'writer' ? 'verifier' : 'purge',
          {
            id: mismatch === 'id' ? 'MISSING' : 'JOB',
            owner: mismatch === 'owner' ? 'WRONG' : 'OWNER',
            fence: mismatch === 'fence' ? 2 : 1,
          },
          {},
        );
        await expect(
          f.repo.decide(f.org, fence, {
            id: a.id,
            state: 'expired',
            expectedRevision: 1,
            decidedByUserId: null,
            now: f.now,
            event: f.event('package.access_decide', true),
          }),
        ).rejects.toMatchObject({ code: 'forbidden' });
        expect((await f.repo.get(f.org, a.id))?.state).toBe('pending');
      },
    );
    it.each(['source', 'attachment', 'held', 'package'] as const)(
      'refuses approval after the %s becomes unavailable',
      async (target) => {
        const a = await create();
        if (target === 'source') await f.seed("UPDATE source SET status = 'paused'");
        if (target === 'attachment') await f.seed('DELETE FROM project_source');
        if (target === 'held') await f.seed('UPDATE package SET held_until_active = 1');
        if (target === 'package') await f.seed("UPDATE package SET status = 'removed_upstream'");
        expect((await decide(a.id)).changed).toBe(false);
        expect(await rows('SELECT package_id FROM project_package')).toEqual([]);
      },
    );
    it('refuses an expiry lease belonging to an unrelated job', async () => {
      const a = await create();
      await f.seed("UPDATE package_access_request SET expires_at = '2000-01-01T00:00:00.000Z'");
      await f.seed(
        "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES ('OTHERJOB', ?, 'core:blob-purge:v1', 'other', 'running', 'OWNER', '2099-01-01T00:00:00.000Z', 1)",
        f.org.orgId,
      );
      const fence = systemMutationFence('purge', { id: 'OTHERJOB', owner: 'OWNER', fence: 1 }, {});
      await expect(
        f.repo.decide(f.org, fence, {
          id: a.id,
          state: 'expired',
          expectedRevision: 1,
          decidedByUserId: null,
          now: f.now,
          event: f.event('package.access_decide', true),
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect((await f.repo.get(f.org, a.id))?.state).toBe('pending');
    });
    it('refuses expiry from a lost lease or a human session', async () => {
      const a = await create();
      await f.seed("UPDATE package_access_request SET expires_at = '2000-01-01T00:00:00.000Z'");
      const input = {
        id: a.id,
        state: 'expired' as const,
        expectedRevision: 1,
        decidedByUserId: null,
        now: f.now,
        event: f.event('package.access_decide', true),
      };
      await expect(f.repo.decide(f.org, f.decideFence, input)).rejects.toMatchObject({
        code: 'forbidden',
      });
      const fence = systemMutationFence('purge', { id: 'MISSING', owner: 'OWNER', fence: 1 }, {});
      await expect(f.repo.decide(f.org, fence, input)).rejects.toMatchObject({ code: 'forbidden' });
      expect(await rows('SELECT id FROM audit_pending')).toHaveLength(1);
    });
  });
}
