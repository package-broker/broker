import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { trustedPublisherPrincipalName } from '@package-broker/core/api/routes/trusted-publishers-name';
import { ulid } from '@package-broker/core/ids';
import { accessFixture } from './package-access-requests-fixture.js';
import { ANCHORS } from '../testing/mutation-table/fixtures.js';
import { createWorkloadTokenService } from '@package-broker/core/authz/service-token-service';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { hashToken } from '@package-broker/core/secrets/token-hash';
import { createWorkloadTokenStore } from '../repositories/workload-token.js';
import { createOidcRepository } from '../repositories/oidc.js';
import {
  createTrustedPublisherStore,
  createTrustedPublisherLookup,
} from '../repositories/trusted-publishers.js';

export function describeTrustedPublishers(
  name: string,
  open: () => Promise<{ executor: SqlExecutor; close(): Promise<void> }>,
) {
  describe(`trusted publisher admin: ${name}`, () => {
    let database: Awaited<ReturnType<typeof open>>;
    let f: Awaited<ReturnType<typeof accessFixture>>;
    let store: ReturnType<typeof createTrustedPublisherStore>;
    beforeEach(async () => {
      database = await open();
      f = await accessFixture(database.executor);
      await f.seed(
        "UPDATE role_permission SET permission = 'org:packages:publish' WHERE role_id = 'R-decider'",
      );
      await f.seed(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R-decider', 'org:service-principals:write')",
        f.org.orgId,
      );
      await f.seed(
        "INSERT INTO registered_name (id,org_id,source_id,ecosystem,pattern) VALUES ('claim',?, 'SOURCE', 'npm', 'widget')",
        f.org.orgId,
      );
      store = createTrustedPublisherStore(database.executor, ANCHORS);
    });
    afterEach(async () => database.close());
    const write = () => ({
      id: ulid(),
      principalId: ulid(),
      now: f.now,
      event: {
        ...f.event('package.access_request'),
        payloadJson: JSON.stringify({ op_id: ulid(), request_id: ulid() }),
      },
      input: {
        packageName: 'widget',
        repository: 'owner/repo',
        workflow: 'publish.yml',
        environment: 'Prod',
      },
      identity: { repository: 'owner/repo', repositoryId: '123', repositoryOwnerId: '456' },
    });
    const create = () => store.create(f.org, f.decideFence, write());
    it('atomically creates the bounded principal, publish grant, folded binding and audit; scopes reads', async () => {
      const item = await create();
      expect(item).toMatchObject({
        environment: 'prod',
        repository: 'owner/repo',
        workflow: 'publish.yml',
        revision: 1,
      });
      expect((await store.list(f.org)).items).toHaveLength(1);
      expect(await store.get(f.orgs.b, item.id)).toBeNull();
      expect((await store.list(f.orgs.b)).items).toEqual([]);
      expect(
        await database.executor.all({
          sql: 'SELECT permission FROM service_principal_permission',
          params: [],
        }),
      ).toEqual([{ permission: 'org:packages:publish' }]);
    });
    it.each(['{', 'null', '{}'])(
      'rejects malformed audit context with a fixed error and no writes: %s',
      async (payloadJson) => {
        const w = write();
        await expect(
          store.create(f.org, f.decideFence, { ...w, event: { ...w.event, payloadJson } }),
        ).rejects.toMatchObject({ code: 'invalid_request', message: 'invalid_request' });
        expect((await store.list(f.org)).items).toEqual([]);
        expect(
          await database.executor.all({ sql: 'SELECT id FROM audit_pending', params: [] }),
        ).toEqual([]);
      },
    );
    it('pages in id order with an organization-scoped cursor and validates bounds', async () => {
      const rows = [];
      for (let i = 0; i < 3; i++)
        rows.push(
          await store.create(f.org, f.decideFence, {
            ...write(),
            input: { ...write().input, environment: `env${i}` },
          }),
        );
      rows.sort((a, b) => a.id.localeCompare(b.id));
      const first = await store.list(f.org, { limit: 2 });
      expect(first.items.map((row) => row.id)).toEqual(rows.slice(0, 2).map((row) => row.id));
      expect(first.next).toBe(rows[1]!.id);
      const last = await store.list(f.org, { limit: 2, cursor: first.next! });
      expect(last.items.map((row) => row.id)).toEqual([rows[2]!.id]);
      expect(last.next).toBeNull();
      expect(await store.list(f.orgs.b, { limit: 2, cursor: first.next! })).toEqual({
        items: [],
        next: null,
      });
      for (const query of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { cursor: 'bad' }])
        await expect(store.list(f.org, query)).rejects.toMatchObject({ code: 'invalid_request' });
    });
    it('audits every restriction before and after a fenced edit and refuses stale audit writes', async () => {
      const a = await create();
      await f.seed(
        "INSERT INTO registered_name (id,org_id,source_id,ecosystem,pattern) VALUES ('claim-next',?, 'SOURCE', 'npm', 'next')",
        f.org.orgId,
      );
      const edit = {
        ...write(),
        id: a.id,
        expectedRevision: 1,
        input: {
          packageName: 'next',
          repository: 'owner/next',
          workflow: 'next.yml',
          environment: 'Stage',
          refPattern: 'refs/tags/v*',
        },
        identity: { repository: 'owner/next', repositoryId: '789', repositoryOwnerId: '987' },
      };
      await store.update(f.org, f.decideFence, edit);
      const audits = await database.executor.all<{ payload_json: string }>({
        sql: 'SELECT payload_json FROM audit_pending WHERE org_id = ? AND id = ?',
        params: [f.org.orgId, edit.event.id],
      });
      expect(JSON.parse(audits[0]!.payload_json)).toEqual({
        op_id: expect.any(String),
        request_id: expect.any(String),
        changes: {
          package: { old: 'widget', new: 'next' },
          repository: { old: 'owner/repo', new: 'owner/next' },
          repository_id: { old: '123', new: '789' },
          repository_owner_id: { old: '456', new: '987' },
          workflow: { old: 'publish.yml', new: 'next.yml' },
          environment: { old: 'prod', new: 'stage' },
          ref_pattern: { old: null, new: 'refs/tags/v*' },
        },
      });
      const stale = { ...edit, event: write().event };
      await expect(store.update(f.org, f.decideFence, stale)).rejects.toMatchObject({
        code: 'conflict',
      });
      expect(
        await database.executor.all({
          sql: 'SELECT id FROM audit_pending WHERE org_id = ? AND id = ?',
          params: [f.org.orgId, stale.event.id],
        }),
      ).toEqual([]);
    });
    it('audits removal of optional restrictions without dropping their previous values', async () => {
      const w = write();
      const a = await store.create(f.org, f.decideFence, {
        ...w,
        input: { ...w.input, refPattern: 'refs/tags/v*' },
      });
      const edit = {
        ...write(),
        id: a.id,
        expectedRevision: 1,
        input: { ...w.input, environment: '' },
      };
      const updated = await store.update(f.org, f.decideFence, edit);
      expect(updated).toMatchObject({ environment: '', refPattern: null, revision: 2 });
      const [audit] = await database.executor.all<{ payload_json: string }>({
        sql: 'SELECT payload_json FROM audit_pending WHERE org_id = ? AND id = ?',
        params: [f.org.orgId, edit.event.id],
      });
      expect(JSON.parse(audit!.payload_json)).toMatchObject({
        changes: {
          environment: { old: 'prod', new: '' },
          ref_pattern: { old: 'refs/tags/v*', new: null },
        },
      });
    });
    it('rolls back the audit when a concurrent edit wins after the snapshot read', async () => {
      const a = await create();
      let raced = false;
      const racingStore = createTrustedPublisherStore(
        {
          ...database.executor,
          batch: async (statements) => {
            if (!raced) {
              raced = true;
              await f.seed(
                "UPDATE trusted_publisher SET environment = 'concurrent', revision = revision + 1 WHERE org_id = ? AND id = ?",
                f.org.orgId,
                a.id,
              );
            }
            return database.executor.batch(statements);
          },
        },
        ANCHORS,
      );
      const edit = { ...write(), id: a.id, expectedRevision: 1 };
      await expect(racingStore.update(f.org, f.decideFence, edit)).rejects.toMatchObject({
        code: 'conflict',
      });
      expect(raced).toBe(true);
      expect(await store.get(f.org, a.id)).toMatchObject({
        revision: 2,
        environment: 'concurrent',
      });
      expect(
        await database.executor.all({
          sql: 'SELECT id FROM audit_pending WHERE org_id = ? AND id = ?',
          params: [f.org.orgId, edit.event.id],
        }),
      ).toEqual([]);
    });
    it('records complete normalized snapshots on create and disable', async () => {
      const w = write();
      const a = await store.create(f.org, f.decideFence, {
        ...w,
        identity: { ...w.identity, repository: 'Owner/Repo' },
      });
      const event = write().event;
      await store.disable(f.org, f.decideFence, {
        id: a.id,
        expectedRevision: 1,
        now: f.now,
        event,
      });
      const audits = await database.executor.all<{ id: string; payload_json: string }>({
        sql: 'SELECT id, payload_json FROM audit_pending WHERE org_id = ?',
        params: [f.org.orgId],
      });
      const values = {
        package: 'widget',
        repository: 'owner/repo',
        workflow: 'publish.yml',
        environment: 'prod',
        ref_pattern: null,
        repository_id: '123',
        repository_owner_id: '456',
      };
      for (const [id, creating] of [
        [w.event.id, true],
        [event.id, false],
      ] as const) {
        expect(JSON.parse(audits.find((row) => row.id === id)!.payload_json)).toEqual({
          op_id: expect.any(String),
          request_id: expect.any(String),
          changes: Object.fromEntries(
            Object.entries(values).map(([field, value]) => [
              field,
              { old: creating ? null : value, new: value },
            ]),
          ),
        });
      }
    });
    it('creates distinct principals for bindings sharing repository and workflow', async () => {
      const first = await create();
      const second = await store.create(f.org, f.decideFence, {
        ...write(),
        input: { ...write().input, environment: 'Stage' },
      });
      await f.seed(
        "INSERT INTO registered_name (id,org_id,source_id,ecosystem,pattern) VALUES ('claim-other',?, 'SOURCE', 'npm', 'other')",
        f.org.orgId,
      );
      const third = await store.create(f.org, f.decideFence, {
        ...write(),
        input: { ...write().input, packageName: 'other' },
      });
      expect(new Set([first, second, third].map((item) => item.servicePrincipalId)).size).toBe(3);
      expect([first, second, third].map((item) => item.servicePrincipalName)).toEqual(
        await Promise.all(
          [
            ['widget', 'prod'],
            ['widget', 'stage'],
            ['other', 'prod'],
          ].map(([pkg, env]) =>
            trustedPublisherPrincipalName('owner/repo', 'publish.yml', pkg!, env!),
          ),
        ),
      );
    });
    it('maps unnameable bindings to fixed validation errors before querying or mutating', async () => {
      const rejectingStore = createTrustedPublisherStore(
        {
          ...database.executor,
          all: async () => {
            throw new Error('unexpected_lookup');
          },
          batch: async () => {
            throw new Error('unexpected_write');
          },
        },
        ANCHORS,
      );
      for (const environment of ['person@example.test', 'prod\u200b']) {
        const invalid = { ...write(), input: { ...write().input, environment } };
        await expect(rejectingStore.create(f.org, f.decideFence, invalid)).rejects.toMatchObject({
          code: 'invalid_request',
        });
        await expect(
          rejectingStore.update(f.org, f.decideFence, { ...invalid, expectedRevision: 1 }),
        ).rejects.toMatchObject({ code: 'invalid_request' });
      }
      expect((await store.list(f.org)).items).toEqual([]);
    });
    it('refuses folded duplicates without orphan principals or audits, including disabled bindings', async () => {
      const a = await create();
      await expect(
        store.create(f.org, f.decideFence, {
          ...write(),
          input: { ...write().input, environment: 'prod' },
        }),
      ).rejects.toMatchObject({ code: 'ambiguous_trusted_publisher' });
      await store.disable(f.org, f.decideFence, {
        id: a.id,
        expectedRevision: 1,
        now: f.now,
        event: {
          ...f.event('package.access_request'),
          payloadJson: JSON.stringify({ op_id: ulid(), request_id: ulid() }),
        },
      });
      await expect(create()).rejects.toMatchObject({ code: 'ambiguous_trusted_publisher' });
      expect((await store.list(f.org)).items).toHaveLength(1);
    });
    it('rechecks both permissions, the session and the hosted claim inside the write batch', async () => {
      await f.seed("DELETE FROM role_permission WHERE permission = 'org:service-principals:write'");
      await expect(create()).rejects.toMatchObject({ code: 'forbidden' });
      await f.seed(
        "INSERT INTO role_permission (org_id,role_id,permission) VALUES (?, 'R-decider', 'org:service-principals:write')",
        f.org.orgId,
      );
      await f.seed('DELETE FROM registered_name');
      await expect(create()).rejects.toMatchObject({ code: 'name_not_claimed' });
      expect((await store.list(f.org)).items).toEqual([]);
    });
    it('updates matching fields with revision CAS and refuses stale edits', async () => {
      const a = await create();
      const updated = await store.update(f.org, f.decideFence, {
        ...write(),
        id: a.id,
        expectedRevision: 1,
        input: {
          ...write().input,
          environment: 'Stage',
          workflow: 'release.yml',
          refPattern: 'refs/tags/v*',
        },
      });
      expect(updated).toMatchObject({
        revision: 2,
        environment: 'stage',
        workflow: 'release.yml',
        refPattern: 'refs/tags/v*',
      });
      await expect(
        store.update(f.org, f.decideFence, { ...write(), id: a.id, expectedRevision: 1 }),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect((await store.get(f.org, a.id))?.revision).toBe(2);
    });
    it('disable preserves replay and token bindings and refuses a stale revision', async () => {
      const a = await create();
      await f.seed(
        "INSERT INTO oidc_replay (issuer,jti,org_id,trusted_publisher_id,expires_at) VALUES ('issuer','jti',?,?, '2099-01-01T00:00:00.000Z')",
        f.org.orgId,
        a.id,
      );
      const stamp = new Date().toISOString();
      const oidc = createOidcRepository(database.executor);
      const publisher = (
        await oidc.find(f.org, {
          packageName: a.packageName,
          repositoryId: a.repositoryId,
          repositoryOwnerId: a.repositoryOwnerId,
          workflow: a.workflow,
          environment: a.environment,
        })
      )[0]!;
      const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]);
      const service = createWorkloadTokenService({
        tokens: createWorkloadTokenStore(database.executor),
        keyring,
        clock: { now: () => new Date(stamp) },
        ids: { ulid },
      });
      const issued = await service.issueWorkload(
        f.org,
        {
          publisher,
          replay: oidc.reserveStatements(f.org, {
            issuer: 'https://token.actions.githubusercontent.com',
            jti: 'issued',
            trustedPublisherId: a.id,
            expectedRevision: 1,
            expiresAt: Math.floor(Date.now() / 1000) + 300,
            now: stamp,
          }),
        },
        { requestId: ulid(), changes: {} },
      );
      expect(issued.status).toBe('issued');
      if (issued.status !== 'issued') throw new Error('token_fixture');
      const [token] = await database.executor.all<{
        id: string;
        hash: string;
        revoked_at: string | null;
      }>({
        sql: 'SELECT id, hash, revoked_at FROM token WHERE org_id = ? AND trusted_publisher_id = ?',
        params: [f.org.orgId, a.id],
      });
      expect(token?.hash).toBe(await hashToken(keyring, 1, issued.token));
      expect(token?.revoked_at).toBeNull();
      await expect(
        store.disable(f.org, f.decideFence, {
          id: a.id,
          expectedRevision: 2,
          now: f.now,
          event: {
            ...f.event('package.access_request'),
            payloadJson: JSON.stringify({ op_id: ulid(), request_id: ulid() }),
          },
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(
        await database.executor.all({
          sql: 'SELECT revoked_at FROM token WHERE org_id = ? AND id = ?',
          params: [f.org.orgId, token!.id],
        }),
      ).toEqual([{ revoked_at: null }]);
      await store.disable(f.org, f.decideFence, {
        id: a.id,
        expectedRevision: 1,
        now: f.now,
        event: {
          ...f.event('package.access_request'),
          payloadJson: JSON.stringify({ op_id: ulid(), request_id: ulid() }),
        },
      });
      expect(
        await database.executor.all({
          sql: 'SELECT revoked_at FROM token WHERE org_id = ? AND id = ?',
          params: [f.org.orgId, token!.id],
        }),
      ).toEqual([{ revoked_at: f.now }]);
      expect(await store.get(f.org, a.id)).toMatchObject({ disabledAt: f.now, revision: 2 });
      expect(
        await database.executor.all({
          sql: 'SELECT jti FROM oidc_replay ORDER BY jti',
          params: [],
        }),
      ).toEqual([{ jti: 'issued' }, { jti: 'jti' }]);
    });
    it('rolls back the principal, permission and binding if the audit insert fails', async () => {
      const first = write();
      await store.create(f.org, f.decideFence, first);
      await expect(
        store.create(f.org, f.decideFence, {
          ...write(),
          event: first.event,
          input: { ...first.input, workflow: 'other.yml' },
        }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect((await store.list(f.org)).items).toHaveLength(1);
      expect(
        await database.executor.all({ sql: 'SELECT id FROM service_principal', params: [] }),
      ).toHaveLength(1);
      expect(
        await database.executor.all({ sql: 'SELECT id FROM audit_pending', params: [] }),
      ).toHaveLength(1);
    });
    it('checks session liveness and publish permission in addition to principal write permission', async () => {
      await f.seed("DELETE FROM role_permission WHERE permission = 'org:packages:publish'");
      await expect(create()).rejects.toMatchObject({ code: 'forbidden' });
      await f.seed(
        "INSERT INTO role_permission (org_id,role_id,permission) VALUES (?, 'R-decider', 'org:packages:publish')",
        f.org.orgId,
      );
      await f.seed('DELETE FROM session');
      await expect(create()).rejects.toMatchObject({ code: 'forbidden' });
      expect((await store.list(f.org)).items).toHaveLength(0);
    });
    it('refuses an exchange that read the old revision before a matching-field edit', async () => {
      const a = await create();
      const oidc = createOidcRepository(database.executor);
      const replay = oidc.reserveStatements(f.org, {
        issuer: 'https://token.actions.githubusercontent.com',
        jti: 'old-read',
        trustedPublisherId: a.id,
        expectedRevision: a.revision,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        now: f.now,
      });
      await store.update(f.org, f.decideFence, { ...write(), id: a.id, expectedRevision: 1 });
      await expect(database.executor.batch(replay.appendTo([]))).rejects.toThrow();
      expect(
        await database.executor.all({ sql: 'SELECT jti FROM oidc_replay', params: [] }),
      ).toEqual([]);
    });
    it('refuses a folded environment collision on update without changing revision', async () => {
      await create();
      const b = await store.create(f.org, f.decideFence, {
        ...write(),
        input: { ...write().input, environment: 'Stage' },
      });
      await expect(
        store.update(f.org, f.decideFence, {
          ...write(),
          id: b.id,
          expectedRevision: 1,
          input: { ...write().input, environment: 'pRoD' },
        }),
      ).rejects.toMatchObject({ code: 'ambiguous_trusted_publisher' });
      expect((await store.get(f.org, b.id))?.revision).toBe(1);
    });
    it('resolves only a configured organization GitHub source for the exact repository', async () => {
      const seen: string[] = [];
      const lookup = createTrustedPublisherLookup(database.executor, async (_org, source) => {
        seen.push(source);
        return write().identity;
      });
      const signal = new AbortController().signal;
      expect(await lookup(f.org, 'owner/repo', signal)).toBeNull();
      await f.seed(
        "INSERT INTO credential (id,org_id,project_id,kind,ciphertext,nonce,key_version,aad) VALUES ('github-credential',?,NULL,'bearer',X'01',zeroblob(12),1,'test')",
        f.org.orgId,
      );
      await f.seed(
        "INSERT INTO source (id,org_id,name,ecosystem,type,credential_id,config_json) VALUES ('github-source',?,'GitHub','npm','vcs','github-credential',?)",
        f.org.orgId,
        JSON.stringify({ provider: 'github', repository: 'Owner/Repo' }),
      );
      expect(await lookup(f.org, 'owner/repo', signal)).toEqual(write().identity);
      expect(seen).toEqual(['github-source']);
      expect(await lookup(f.orgs.b, 'owner/repo', signal)).toBeNull();
      expect(await lookup(f.org, 'owner/other', signal)).toBeNull();
      await f.seed("UPDATE source SET project_id = 'PROJECT' WHERE id = 'github-source'");
      expect(await lookup(f.org, 'owner/repo', signal)).toBeNull();
      await f.seed(
        "UPDATE source SET project_id = NULL, status = 'paused' WHERE id = 'github-source'",
      );
      expect(await lookup(f.org, 'owner/repo', signal)).toBeNull();
      expect(seen).toHaveLength(1);
    });
  });
}
