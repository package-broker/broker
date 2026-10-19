import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newSessionSecrets } from '@package-broker/core/auth/session';
import { authenticatedActorOf } from '@package-broker/core/authz/access-context';
import { mutationFence } from '@package-broker/core/authz/fence';
import { type SqlValue } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { KernelConfigError } from '@package-broker/core/kernel/registry';
import { resolvedPackageOf } from '@package-broker/core/kernel/package-context';
import { SUPPORTED_PLUGIN_API, type PluginDefinition } from '@package-broker/core/plugin';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import {
  openMigratedDatabase,
  type MigratedDatabase,
} from '@package-broker/db-sqlite/testing/migrated-database';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createNodeServer, type NodeBroker } from './index.js';

const ANCHOR = 'oidc:https://idp.example.test';
const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

describe('node catalogue wiring on node:sqlite', () => {
  let db: MigratedDatabase;
  let broker: NodeBroker;
  let cookie: string;
  let csrf: string;
  let orgId: string;
  let projectId: string;
  let sourceId: string;
  let packageId: string;
  let reached: number;
  let userId: string;

  async function sql(statement: string, params: readonly SqlValue[] = []): Promise<void> {
    await db.executor.all({ sql: statement, params });
  }

  const plugin: PluginDefinition = {
    id: 'catalogue-fixture',
    package: '@test/catalogue-fixture',
    apiVersion: SUPPORTED_PLUGIN_API[0],
    platforms: ['node'],
    binds: ['identity'],
    identityProviders: () => [
      {
        id: 'oidc',
        kind: 'oidc',
        displayName: 'Fixture',
        trustAnchor: ANCHOR,
        policy: {
          verifiedDomains: ['example.test'],
          emailAuthoritativeDomains: ['example.test'],
          autoJoin: false,
        },
        supportsReauth: false,
        start: () => Promise.resolve({ kind: 'direct' }),
        finish: () => Promise.resolve({ ok: false, reason: 'provider_error' }),
      },
    ],
    register(registry) {
      for (const mode of ['read', 'fetch']) {
        registry.route({
          method: 'GET',
          path: `/fixture/:project/${mode}/:name`,
          boundary: 'package',
          permission: 'project:packages:read',
          package: {
            ecosystem: 'npm',
            name: (params) => params['name'] ?? null,
            fetchOnAdmission: mode === 'fetch',
          },
          handler: (ctx) => {
            reached += 1;
            return Response.json(resolvedPackageOf(ctx));
          },
        });
      }
      registry.route({
        method: 'POST',
        path: '/fixture/hide',
        boundary: 'organization',
        permission: 'org:sources:write',
        handler: async (ctx) => {
          const actor = authenticatedActorOf(ctx);
          if (actor === null || ctx.org === null) throw new Error('missing actor');
          const services = await broker.services();
          const visibility = services.packages?.visibility;
          if (visibility === undefined) throw new Error('missing catalogue services');
          return Response.json(
            await visibility.setPackageFlag(ctx.org, mutationFence(actor, {}), {
              packageId,
              visibleToNewProjects: false,
            }),
          );
        },
      });
    },
  };

  beforeEach(async () => {
    db = await openMigratedDatabase();
    const org = await createOrganizationBootstrap(db.executor).bootstrap({
      id: ulid(),
      slug: 'acme',
      name: 'Acme',
      now: new Date().toISOString(),
    });
    orgId = org.id;
    projectId = ulid();
    sourceId = ulid();
    packageId = ulid();
    reached = 0;
    userId = ulid();
    const roleId = ulid();
    const secrets = await newSessionSecrets();
    csrf = secrets.csrf;
    cookie = `__Host-pb_session=${secrets.secret}; __Host-pb_csrf=${csrf}`;
    await sql('INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)', [
      userId,
      orgId,
      'reader@example.test',
    ]);
    const credentialId = ulid();
    await sql(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', ?, zeroblob(12), 1, 'fixture')",
      [credentialId, orgId, new Uint8Array([1])],
    );
    await sql(
      "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, last_login_at) VALUES (?, ?, 'pbkdf2-sha256$fixture', ?, ?, ?)",
      [userId, orgId, credentialId, new Date().toISOString(), new Date().toISOString()],
    );
    await sql(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'fixture', 'Fixture', 'organization', 1)",
      [roleId, orgId],
    );
    for (const permission of ['project:packages:read', 'org:sources:write']) {
      await sql('INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)', [
        orgId,
        roleId,
        permission,
      ]);
    }
    await sql(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', ?, 'organization', ?)",
      [ulid(), orgId, 'reader@example.test', roleId],
    );
    await sql(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        ulid(),
        orgId,
        userId,
        secrets.secretHash,
        secrets.csrfHash,
        new Date(Date.now() + 3600000).toISOString(),
      ],
    );
    await sql("INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'alpha', 'Alpha')", [
      projectId,
      orgId,
    ]);
    await sql(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'fixture', 'npm', 'npm_registry')",
      [sourceId, orgId],
    );
    await sql('INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)', [
      orgId,
      projectId,
      sourceId,
    ]);
    await sql(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name, visible_to_new_projects) VALUES (?, ?, ?, 'npm', 'visible', 1)",
      [packageId, orgId, sourceId],
    );
    await sql(
      "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, 'subscription')",
      [orgId, projectId, packageId],
    );
    await sql(
      "INSERT INTO version (id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, metadata_json) VALUES (?, ?, ?, '1.0.0', '1.0.0', 'stable', ?, 'import_time', '{}')",
      [ulid(), orgId, packageId, new Date().toISOString()],
    );
    broker = createNodeServer([plugin], {
      executor: db.executor,
      auth: {
        keyring: createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
        publicOrigin: 'https://broker.test',
        env: {},
      },
      log: () => undefined,
    });
    await broker.ready();
  });

  afterEach(async () => {
    await broker?.close();
    await db?.close();
  });

  async function get(
    name: string,
    mode = 'read',
    method = 'GET',
    authenticated = true,
  ): Promise<Response> {
    const kernel = await broker.ready();
    return kernel.fetch(
      new Request(`https://broker.test/fixture/alpha/${mode}/${encodeURIComponent(name)}`, {
        method,
        headers: authenticated ? { cookie } : {},
      }),
    );
  }

  async function absent(name: string) {
    const response = await get(name);
    expect(response.status).toBe(404);
    return {
      status: response.status,
      headers: Object.fromEntries(
        [
          'content-type',
          'cache-control',
          'content-security-policy',
          'x-content-type-options',
          'x-frame-options',
          'referrer-policy',
          'strict-transport-security',
          'permissions-policy',
          'vary',
        ].map((name) => [name, response.headers.get(name)]),
      ),
      body: (await response.text()).replace(/"requestId":"[^"]*"/, '"requestId":"-"'),
    };
  }

  it('resolves a visible package through the real authorization engine', async () => {
    const response = await get('visible');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: 'visible',
      pkg: { packageId, projectId, sourceId },
    });
    expect(reached).toBe(1);
    expect((await get('visible', 'read', 'HEAD')).status).toBe(200);
  });

  it('refuses unauthenticated reads before the handler', async () => {
    expect((await get('visible', 'read', 'GET', false)).status).toBe(401);
    expect((await get('visible', 'fetch', 'GET', false)).status).toBe(401);
    expect(reached).toBe(0);
  });

  it('makes invisible, missing and malformed names uniformly absent', async () => {
    await sql('DELETE FROM project_package WHERE org_id = ? AND project_id = ?', [
      orgId,
      projectId,
    ]);
    expect(await absent('visible')).toEqual(await absent('missing'));
    expect(await absent('INVALID NAME')).toEqual(await absent('missing'));
    expect(reached).toBe(0);
  });

  it('refuses an archived project and a revoked session', async () => {
    await sql("UPDATE project SET status = 'archived' WHERE org_id = ? AND id = ?", [
      orgId,
      projectId,
    ]);
    await absent('visible');
    await sql('UPDATE session SET revoked_at = ? WHERE org_id = ?', [
      new Date().toISOString(),
      orgId,
    ]);
    expect((await get('visible')).status).toBe(401);
    expect(reached).toBe(0);
  });

  it('delivers proxy admission only to fetchOnAdmission GET handlers', async () => {
    const proxy = ulid();
    await sql(
      "INSERT INTO source (id, org_id, name, ecosystem, type, default_visible_to_new_projects) VALUES (?, ?, 'proxy', 'npm', 'npmjs_proxy', 1)",
      [proxy, orgId],
    );
    await sql('INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)', [
      orgId,
      projectId,
      proxy,
    ]);
    await absent('new-package');
    expect((await get('new-package', 'fetch', 'HEAD')).status).toBe(404);
    expect(reached).toBe(0);
    const response = await get('new-package', 'fetch');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: 'proxy_admissible',
      projectId,
      ecosystem: 'npm',
      key: 'new-package',
      sourceIds: [proxy],
    });
    await sql('DELETE FROM project_package WHERE org_id = ?', [orgId]);
    expect((await get('visible', 'fetch')).status).toBe(404);
    expect(reached).toBe(1);
  });

  it('wires scoped npm admission', async () => {
    await sql(
      'UPDATE source SET config_json = ?, default_visible_to_new_projects = 1 WHERE org_id = ? AND id = ?',
      [JSON.stringify({ scopes: ['@acme'] }), orgId, sourceId],
    );
    await sql(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'npm', '@acme/*')",
      [ulid(), orgId, sourceId],
    );
    const response = await get('@acme/new', 'fetch');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: 'proxy_admissible',
      sourceIds: [sourceId],
    });
    expect((await get('@other/new', 'fetch')).status).toBe(404);
  });

  it('enforces project ownership despite forged visibility rows', async () => {
    const otherProject = ulid();
    await sql("INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'beta', 'Beta')", [
      otherProject,
      orgId,
    ]);
    await sql('UPDATE source SET project_id = ? WHERE org_id = ? AND id = ?', [
      otherProject,
      orgId,
      sourceId,
    ]);
    await absent('visible');
    expect((await get('visible', 'fetch', 'HEAD')).status).toBe(404);
    expect(reached).toBe(0);
  });

  it('groups catalogue services like Cloudflare without exposing the raw visibility store', async () => {
    const services = await broker.services();
    expect(Object.keys(services).sort()).toEqual([
      'access',
      'catalogue',
      'dispatch',
      'packages',
      'providerAnchors',
    ]);
    expect(Object.keys(services.packages ?? {}).sort()).toEqual([
      'closureReport',
      'packageAccess',
      'reader',
      'visibility',
      'writer',
    ]);
    expect(services).toMatchObject({
      catalogue: { resolveVersions: expect.any(Function) },
      packages: {
        reader: { resolveVersions: expect.any(Function), pageEdges: expect.any(Function) },
        writer: { syncPackage: expect.any(Function) },
        packageAccess: { resolve: expect.any(Function), dist: expect.any(Function) },
        visibility: { setPackageFlag: expect.any(Function) },
        closureReport: expect.any(Function),
      },
    });
    const response = await (
      await broker.ready()
    ).fetch(
      new Request('https://broker.test/fixture/hide', {
        method: 'POST',
        headers: { cookie, origin: 'https://broker.test', 'x-csrf-token': csrf },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    await absent('visible');
    expect(
      await db.executor.all({
        sql: 'SELECT visible_to_new_projects AS visible FROM package WHERE org_id = ? AND id = ?',
        params: [orgId, packageId],
      }),
    ).toEqual([{ visible: 0 }]);
  });

  it('authorizes visibility writes through the assembled provider anchor', async () => {
    await sql('DELETE FROM local_login WHERE org_id = ? AND user_id = ?', [orgId, userId]);
    await sql('INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)', [
      orgId,
      'oidc',
      ANCHOR,
    ]);
    await sql(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      [ulid(), orgId, userId, 'oidc', 'reader', 'reader@example.test', new Date().toISOString()],
    );
    const response = await (
      await broker.ready()
    ).fetch(
      new Request('https://broker.test/fixture/hide', {
        method: 'POST',
        headers: { cookie, origin: 'https://broker.test', 'x-csrf-token': csrf },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    await absent('visible');
  });

  it.each(['no database', 'no auth'] as const)(
    'has no package services with %s',
    async (missing) => {
      await broker.close();
      broker = createNodeServer([], {
        ...(missing === 'no database'
          ? {
              auth: {
                keyring: createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
                publicOrigin: 'https://broker.test',
                env: {},
              },
            }
          : { executor: db.executor }),
        log: () => undefined,
      });
      expect((await broker.services()).packages).toBeNull();
    },
  );

  it('rejects package route registration without a database', async () => {
    await broker.close();
    broker = createNodeServer([plugin], { log: () => undefined });
    await expect(broker.ready()).rejects.toBeInstanceOf(KernelConfigError);
    await expect(broker.ready()).rejects.toMatchObject({
      problems: expect.arrayContaining([expect.stringContaining('package resolver exists')]),
    });
    expect(reached).toBe(0);
  });
});
