import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { fixedClock } from '@package-broker/core/ids';
import { createSecretCipher } from '@package-broker/core/secrets/cipher';
import { createCredentialStore } from '@package-broker/core/secrets/credential-store';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { createSourceService, type SourceActor } from '@package-broker/core/sources/source-service';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCredentialRepository } from './credential.js';
import { createOrganizationRepository } from './organization.js';
import { createRegisteredNameRepository } from './registered-name.js';
import { createSourceRepository } from './source.js';

const USER = 'source-admin';
const SESSION = 'source-session';
const SOURCE = 'source';
const NOW = '2026-10-18T12:00:00.000Z';
const ANCHORS = [
  {
    provider: 'oidc',
    anchor: 'oidc:https://idp.example.test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const actor: SourceActor = {
  kind: 'org',
  actor: {
    kind: 'organization',
    userId: USER,
    isOrganizationAdmin: true,
    permissions: new Set(['org:sources:write']),
  },
};
const fence = mutationFence({ userId: USER, sessionId: SESSION } as AuthenticatedActor, {});
const input = {
  projectId: null,
  name: 'private',
  type: 'composer_repository' as const,
  ecosystem: 'composer' as const,
  url: 'https://packages.example.test',
  configJson: '{}',
};
const projectActor = (orgId: OrgContext['orgId'], projectId: string): SourceActor => ({
  kind: 'project',
  actor: {
    kind: 'project',
    userId: USER,
    orgId,
    projectId,
    permissions: new Set(['project:sources:write']),
  },
});
const githubApp = {
  appId: '12345',
  privateKeyPem: '-----BEGIN PRIVATE KEY-----\nc3VwM3JzM2NyZXR2YWx1ZQ==\n-----END PRIVATE KEY-----',
  webhookSecret: 'github-webhook-secret',
};
const githubSource = {
  ...input,
  type: 'vcs' as const,
  url: null,
  configJson: JSON.stringify({ provider: 'github', repository: 'owner/name' }),
};
const credential = (token: string) => ({
  kind: 'bearer' as const,
  plaintext: JSON.stringify({ token: `${token}-token` }),
});

let database: MigratedDatabase;
let ctx: OrgContext;
let beforeBatch: (() => Promise<void>) | undefined;
let batches: (readonly Statement[])[];
let service: ReturnType<typeof createSourceService>;
let credentials: ReturnType<typeof createCredentialStore>;
let credentialRows: ReturnType<typeof createCredentialRepository>;
let sources: ReturnType<typeof createSourceRepository>;

function statement(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  ctx = database.orgs.a;
  const executor = database.executor;
  await executor.batch([
    statement(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('source-role', ?, 'sources', 'Sources', 'organization', 0)",
      ctx.orgId,
    ),
    statement(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'source-role', 'org:sources:write')",
      ctx.orgId,
    ),
    statement(
      "INSERT INTO user_account (id, org_id, email) VALUES (?, ?, 'admin@example.test')",
      USER,
      ctx.orgId,
    ),
    statement(
      "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'oidc:https://idp.example.test')",
      ctx.orgId,
    ),
    statement(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('source-identity', ?, ?, 'oidc', 'admin', 'admin@example.test', 1, ?)",
      ctx.orgId,
      USER,
      new Date().toISOString(),
    ),
    statement(
      "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, '2999-01-01T00:00:00.000Z')",
      SESSION,
      ctx.orgId,
      USER,
      'a'.repeat(64),
      'b'.repeat(64),
      new Date().toISOString(),
      new Date().toISOString(),
    ),
    statement(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('source-grant', ?, 'email', 'admin@example.test', 'organization', 'source-role')",
      ctx.orgId,
    ),
  ]);
  beforeBatch = undefined;
  batches = [];
  const observed: SqlExecutor = {
    driver: executor.driver,
    all: (query) => executor.all(query),
    async batch(queries) {
      batches.push(queries);
      const hook = beforeBatch;
      beforeBatch = undefined;
      await hook?.();
      return executor.batch(queries);
    },
  };
  let nextCredential = 0;
  credentialRows = createCredentialRepository(observed);
  credentials = createCredentialStore({
    repository: credentialRows,
    cipher: createSecretCipher(
      createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
      'credential-encryption',
    ),
    ids: { ulid: () => `credential-${++nextCredential}` },
    clock: fixedClock(NOW),
  });
  sources = createSourceRepository(observed);
  service = createSourceService({
    sources,
    credentials,
    credentialRepository: credentialRows,
    registeredNames: createRegisteredNameRepository(observed),
    organizations: createOrganizationRepository(observed),
    catalogue: { previewWinners: async () => [] },
    policy: { runtime: 'node', allowPrivateHosts: [], selfOrigins: [] },
    providerAnchors: ANCHORS,
    ids: { ulid: () => SOURCE },
    log: () => {},
  });
});

afterEach(async () => {
  await database.close();
});

async function seedActiveSource() {
  expect(
    await service.create(ctx, actor, fence, { ...input, credential: credential('initial') }),
  ).toMatchObject({ ok: true });
  expectCredentialBatch();
  await database.executor.all(
    statement("UPDATE source SET status = 'active' WHERE org_id = ? AND id = ?", ctx.orgId, SOURCE),
  );
  batches = [];
}

async function persistedState() {
  return {
    source: await sources.get(ctx, SOURCE),
    credentials: await credentialRows.listBelowVersion(ctx, 2, null, 100),
    epoch: await database.executor.all(
      statement('SELECT version FROM cache_epoch WHERE org_id = ?', ctx.orgId),
    ),
  };
}

function expectCredentialBatch() {
  expect(batches).toHaveLength(1);
  expect(batches[0]?.some((query) => /insert into "credential"/i.test(query.sql))).toBe(true);
  expect(batches[0]?.some((query) => /(?:insert into|update) "source"/i.test(query.sql))).toBe(
    true,
  );
}

describe('source service with the SQLite repositories and credential store', () => {
  it('creates and replaces encrypted credentials in the source mutation batch', async () => {
    await seedActiveSource();
    expect(new TextDecoder().decode(await credentials.read(ctx, 'credential-1'))).toBe(
      credential('initial').plaintext,
    );
    expect(
      await service.update(ctx, actor, fence, SOURCE, { credential: credential('replacement') }),
    ).toMatchObject({ ok: true });
    expectCredentialBatch();
    expect(await sources.get(ctx, SOURCE)).toMatchObject({
      credentialId: 'credential-2',
      status: 'active',
    });
    expect(new TextDecoder().decode(await credentials.read(ctx, 'credential-2'))).toBe(
      credential('replacement').plaintext,
    );
    if (database.orgs === null) throw new Error('organizations were not seeded');
    expect(await credentialRows.get(database.orgs.b, 'credential-2')).toBeNull();
  });

  it.each(['create', 'update'] as const)(
    'leaves no prepared credential after a %s fence refusal',
    async (operation) => {
      if (operation === 'update') await seedActiveSource();
      const before = await persistedState();
      beforeBatch = async () => {
        await database.executor.all(
          statement('DELETE FROM session WHERE org_id = ? AND id = ?', ctx.orgId, SESSION),
        );
      };
      const result =
        operation === 'create'
          ? await service.create(ctx, actor, fence, { ...input, credential: credential('new') })
          : await service.update(ctx, actor, fence, SOURCE, { credential: credential('new') });
      expect(result).toEqual({ ok: false, error: 'forbidden' });
      expectCredentialBatch();
      expect(
        await credentialRows.get(ctx, operation === 'create' ? 'credential-1' : 'credential-2'),
      ).toBeNull();
      expect(await persistedState()).toEqual(before);
    },
  );

  it('rolls back a prepared credential when source creation collides after its insert', async () => {
    await seedActiveSource();
    const before = await persistedState();
    expect(
      await service.create(ctx, actor, fence, { ...input, credential: credential('new') }),
    ).toEqual({ ok: false, error: 'duplicate' });
    expectCredentialBatch();
    expect(await credentialRows.get(ctx, 'credential-2')).toBeNull();
    expect(await persistedState()).toEqual(before);
  });

  it.each([false, true])(
    'keeps credential replacement atomic with an injected revision guard (stale: %s)',
    async (stale) => {
      await seedActiveSource();
      const revisionFence = mutationFence(
        { userId: USER, sessionId: SESSION } as AuthenticatedActor,
        { 'source-role': 1 },
      );
      // Sources have no revision guard. Inject a CAS failure at the final write to exercise
      // rollback after the real prepared credential insert, without changing production SQL.
      await database.executor.all(
        statement(`CREATE TEMP TRIGGER source_revision_fixture BEFORE UPDATE ON source
          WHEN (SELECT revision FROM role WHERE org_id = NEW.org_id AND id = 'source-role') <> 1
          BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: source_revision_fixture'); END`),
      );
      const before = await persistedState();
      if (stale) {
        beforeBatch = async () => {
          await database.executor.all(
            statement(
              "UPDATE role SET revision = revision + 1 WHERE org_id = ? AND id = 'source-role'",
              ctx.orgId,
            ),
          );
        };
      }
      const result = await service.update(ctx, actor, revisionFence, SOURCE, {
        credential: credential('replacement'),
      });
      expectCredentialBatch();
      if (stale) {
        expect(result).toEqual({ ok: false, error: 'conflict' });
        expect(await credentialRows.get(ctx, 'credential-2')).toBeNull();
        expect(await persistedState()).toEqual(before);
      } else {
        expect(result).toMatchObject({ ok: true });
        expect(await credentialRows.get(ctx, 'credential-2')).not.toBeNull();
        expect(await sources.get(ctx, SOURCE)).toMatchObject({ credentialId: 'credential-2' });
      }
    },
  );

  it('returns an empty-patch validation failure without issuing a mutation batch', async () => {
    await seedActiveSource();
    const before = await persistedState();
    expect(await service.update(ctx, actor, fence, SOURCE, {})).toMatchObject({
      ok: false,
      error: 'invalid_config',
      problems: [{ field: 'changes' }],
    });
    expect(batches).toHaveLength(0);
    expect(await persistedState()).toEqual(before);
  });

  it('preserves active status on polling and credential-detachment patches', async () => {
    await seedActiveSource();
    for (const patch of [{ pollIntervalSeconds: 600 }, { credential: null }]) {
      expect(await service.update(ctx, actor, fence, SOURCE, patch)).toMatchObject({ ok: true });
      expect(await sources.get(ctx, SOURCE)).toMatchObject({ status: 'active' });
    }
    expect(await sources.get(ctx, SOURCE)).toMatchObject({
      credentialId: null,
      pollIntervalSeconds: 600,
    });
  });

  describe('linking an existing credential', () => {
    const put = (context: OrgContext, kind: string, projectId: string | null, material: object) =>
      credentials.put(context, {
        kind,
        projectId,
        plaintext: new TextEncoder().encode(JSON.stringify(material)),
      });
    const countRows = async (table: 'credential' | 'source') =>
      (
        await database.executor.all(
          statement(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?`, ctx.orgId),
        )
      )[0];

    beforeEach(async () => {
      await database.executor.batch([
        statement(
          "INSERT INTO project (id, org_id, slug, name) VALUES ('project-a', ?, 'project-a', 'A'), ('project-b', ?, 'project-b', 'B')",
          ctx.orgId,
          ctx.orgId,
        ),
        statement(
          "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('project-source-role', ?, 'project-sources', 'Project sources', 'project', 0)",
          ctx.orgId,
        ),
        statement(
          "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'project-source-role', 'project:sources:write')",
          ctx.orgId,
        ),
        statement(
          "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, project_id, role_id) VALUES ('grant-a', ?, 'email', 'admin@example.test', 'project', 'project-a', 'project-source-role'), ('grant-b', ?, 'email', 'admin@example.test', 'project', 'project-b', 'project-source-role')",
          ctx.orgId,
          ctx.orgId,
        ),
      ]);
    });

    it('stores the id of an organization credential without inserting a credential row', async () => {
      const id = await put(ctx, 'bearer', null, { token: 'shared-token' });
      const before = await countRows('credential');
      expect(await service.create(ctx, actor, fence, { ...input, credentialId: id })).toEqual({
        ok: true,
        value: { id: SOURCE },
      });
      expect((await sources.get(ctx, SOURCE))?.credentialId).toBe(id);
      expect(await countRows('credential')).toEqual(before);
    });

    it('refuses plaintext and credentialId together without writing', async () => {
      const id = await put(ctx, 'bearer', null, { token: 'shared-token' });
      batches = [];
      expect(
        await service.create(ctx, actor, fence, {
          ...input,
          credential: credential('both'),
          credentialId: id,
        }),
      ).toMatchObject({ ok: false, error: 'invalid_config', problems: [{ field: 'credential' }] });
      expect(batches).toHaveLength(0);
      expect(await sources.get(ctx, SOURCE)).toBeNull();
    });

    it.each([
      ['project source, organization credential', 'project-a', null, 'project-a'],
      ['organization source, project credential', null, 'project-a', null],
      ['project source, other project credential', 'project-a', 'project-b', 'project-a'],
    ] as const)(
      'refuses an owner mismatch: %s',
      async (_name, sourceProject, owner, actorProject) => {
        const id = await put(ctx, 'bearer', owner, { token: 'shared-token' });
        const result = await service.create(
          ctx,
          actorProject === null ? actor : projectActor(ctx.orgId, actorProject),
          fence,
          { ...input, projectId: sourceProject, credentialId: id },
        );
        expect(result).toEqual({ ok: false, error: 'credential_scope_mismatch' });
        expect(await sources.get(ctx, SOURCE)).toBeNull();
        expect(
          await service.create(
            ctx,
            actorProject === null ? actor : projectActor(ctx.orgId, actorProject),
            fence,
            { ...input, projectId: sourceProject },
          ),
        ).toMatchObject({ ok: true });
      },
    );

    it.each(['bearer', 'github_app'] as const)(
      'answers a foreign and a missing credential identically (%s)',
      async (kind) => {
        if (database.orgs === null) throw new Error('organizations were not seeded');
        const material = kind === 'github_app' ? githubApp : { token: 'foreign-token' };
        const foreign = await put(database.orgs.b, kind, null, material);
        const base = kind === 'github_app' ? githubSource : input;
        const refusedForeign = await service.create(ctx, actor, fence, {
          ...base,
          credentialId: foreign,
        });
        const refusedMissing = await service.create(ctx, actor, fence, {
          ...base,
          credentialId: 'does-not-exist',
        });
        expect(refusedForeign).toEqual({ ok: false, error: 'credential_scope_mismatch' });
        expect(refusedMissing).toEqual({ ok: false, error: 'credential_scope_mismatch' });
        expect(refusedForeign).toEqual(refusedMissing);
        expect(await sources.get(ctx, SOURCE)).toBeNull();
      },
    );

    it('accepts a github_app credential and refuses another kind for a GitHub App source', async () => {
      const app = await put(ctx, 'github_app', null, githubApp);
      const token = await put(ctx, 'bearer', null, { token: 'shared-token' });
      const refused = await service.create(ctx, actor, fence, {
        ...githubSource,
        credentialId: token,
      });
      expect(refused).toMatchObject({ ok: false });
      expect(refused).toEqual(
        await service.create(ctx, actor, fence, { ...githubSource, credentialId: 'missing' }),
      );
      expect(await sources.get(ctx, SOURCE)).toBeNull();
      expect(
        await service.create(ctx, actor, fence, { ...githubSource, credentialId: app }),
      ).toMatchObject({ ok: true });
      expect((await sources.get(ctx, SOURCE))?.credentialId).toBe(app);
    });
  });
});
