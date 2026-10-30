import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginDefinition } from '@package-broker/core/plugin';
import { orgContext, type SqlExecutor, type SqlValue } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import { createSecretCipher } from '@package-broker/core/secrets/cipher';
import { createCredentialStore } from '@package-broker/core/secrets/credential-store';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { verifyKeyring } from '@package-broker/core/secrets/keyring-verifier';
import { createKeyringVerifierStore } from '@package-broker/db-sqlite/repositories/keyring-verifier';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createCredentialRepository } from '@package-broker/db-sqlite/repositories/credential';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { resolveRegistryConfig } from '@package-broker/core/registry/registry-config';
import { createLruCache } from './cache/lru.js';
import { createNodeServer } from './index.js';

const githubModule = '@package-broker/plugin-github';
const { default: github } = (await import(githubModule)) as { default: () => PluginDefinition };

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const ORIGIN = 'https://broker.test';
const SECRET = 'webhook-secret-that-must-never-be-logged';
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nYWJjZA==\n-----END PRIVATE KEY-----\n';
const BODY = JSON.stringify({
  ref: 'refs/heads/main',
  installation: { id: 123 },
  repository: { full_name: 'team/repo' },
  privateMarker: 'request-body-that-must-never-be-logged',
});
const keyring = () => createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

function githubPlugin(mode: 'real' | 'missing' | 'throwing' = 'real') {
  const base = github();
  const actual = base.sourceProviders!()[0]!.webhookVerifier!;
  const verify = vi.fn(actual.verify.bind(actual));
  if (mode === 'throwing') verify.mockRejectedValue(new Error('verification failed'));
  const plugin: PluginDefinition = {
    ...base,
    sourceProviders: (context) =>
      base.sourceProviders!(context).map((provider) => {
        const patched = { ...provider };
        if (mode === 'missing') delete patched.webhookVerifier;
        else patched.webhookVerifier = { verify };
        return patched;
      }),
  };
  return { plugin, verify };
}

async function seed(executor: SqlExecutor) {
  const sql = (query: string, params: SqlValue[] = []) => executor.batch([{ sql: query, params }]);
  const org = orgContext(ulid());
  await createOrganizationBootstrap(executor).bootstrap({
    id: org.orgId,
    slug: 'registry',
    name: 'Registry',
    now: new Date().toISOString(),
  });
  await verifyKeyring(keyring(), createKeyringVerifierStore(executor));
  const store = createCredentialStore({
    repository: createCredentialRepository(executor),
    cipher: createSecretCipher(keyring(), 'credential-encryption'),
    ids: { ulid },
    clock: systemClock,
  });
  const app = (
    ctx = org,
    projectId: string | null = null,
    plaintext = JSON.stringify({
      appId: '42',
      privateKeyPem: PRIVATE_KEY,
      webhookSecret: SECRET,
    }),
  ) =>
    store.put(ctx, {
      kind: 'github_app',
      projectId,
      plaintext: new TextEncoder().encode(plaintext),
    });
  const credentialId = await app();
  const sourceId = ulid();
  await sql(
    `INSERT INTO source (id, org_id, name, ecosystem, type, config_json, credential_id)
    VALUES (?, ?, 'github', 'composer', 'vcs', ?, ?)`,
    [
      sourceId,
      org.orgId,
      JSON.stringify({ provider: 'github', repository: 'team/repo', installationId: 123 }),
      credentialId,
    ],
  );
  const wrongKind = await store.put(org, {
    kind: 'bearer',
    projectId: null,
    plaintext: new TextEncoder().encode(JSON.stringify({ token: SECRET })),
  });
  const projectId = ulid();
  await sql('INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)', [
    projectId,
    org.orgId,
    'private',
    'Private',
  ]);
  const projectCredential = await app(org, projectId);
  const malformed = await app(org, null, '{}');
  const corrupt = await app();
  await sql('UPDATE credential SET ciphertext = zeroblob(32) WHERE org_id = ? AND id = ?', [
    org.orgId,
    corrupt,
  ]);
  const foreign = orgContext(ulid());
  // Test-only second organization, matching the database contract fixtures.
  await sql('DROP INDEX organization_singleton');
  await sql('INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)', [
    foreign.orgId,
    'foreign',
    'Foreign',
  ]);
  const foreignCredential = await app(foreign);
  const foreignSource = ulid();
  await sql(
    `INSERT INTO source (id, org_id, name, ecosystem, type, config_json, credential_id)
    VALUES (?, ?, 'foreign', 'composer', 'vcs', ?, ?)`,
    [
      foreignSource,
      foreign.orgId,
      JSON.stringify({ provider: 'github', repository: 'team/repo', installationId: 123 }),
      foreignCredential,
    ],
  );
  const rows = (table: 'job' | 'webhook_delivery') =>
    executor.all<Record<string, unknown>>({ sql: `SELECT * FROM ${table}`, params: [] });
  const request = (id = credentialId, secret = SECRET, body = BODY) =>
    new Request(`${ORIGIN}/_pb/hooks/github/${id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': 'untrusted-delivery-id',
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
      body,
    });
  return {
    org,
    sourceId,
    credentialId,
    wrongKind,
    projectCredential,
    malformed,
    corrupt,
    foreignCredential,
    rows,
    request,
  };
}

async function boot(options: { jobs?: boolean; mode?: 'real' | 'missing' | 'throwing' } = {}) {
  const db = await openMigratedDatabase();
  cleanup.push(() => db.close());
  const fixture = await seed(db.executor);
  const { plugin, verify } = githubPlugin(options.mode);
  const logged: unknown[] = [];
  const broker = createNodeServer([plugin], {
    executor: db.executor,
    auth: { keyring: keyring(), publicOrigin: ORIGIN, env: {} },
    ...(options.jobs === false
      ? {}
      : {
          platformServices: {
            blob: {
              async stage() {
                throw new Error('not_implemented');
              },
              async openStaged() {
                throw new Error('not_implemented');
              },
              async promote() {
                throw new Error('not_implemented');
              },
              async discard() {
                throw new Error('not_implemented');
              },
              put: async () => {
                throw new Error('unexpected blob write');
              },
              head: async () => null,
              get: async () => null,
            },
            cache: createLruCache({}),
            jobStore: createJobRepository(db.executor),
          },
          registry: { config: resolveRegistryConfig(undefined, 'node', ORIGIN) },
        }),
    log: (record) => {
      logged.push(record);
    },
  });
  cleanup.push(() => broker.close());
  const kernel = await broker.ready();
  return { fetch: kernel.fetch, fixture, verify, logged };
}

describe('Node webhook assembly', () => {
  it('accepts a signed anonymous delivery without an API plugin and enqueues once on redelivery', async () => {
    const { fetch, fixture, verify, logged } = await boot();
    expect((await fetch(fixture.request())).status).toBe(202);
    const repeated = fixture.request();
    repeated.headers.set('x-github-delivery', 'another-untrusted-id');
    expect((await fetch(repeated)).status).toBe(202);
    expect(verify).toHaveBeenCalledTimes(2);
    const jobs = await fixture.rows('job');
    expect(jobs).toEqual([
      expect.objectContaining({
        org_id: fixture.org.orgId,
        type: 'core:source-sync:v1',
        resource_key: `source:${fixture.sourceId}`,
      }),
    ]);
    expect(JSON.parse(jobs[0]!.payload_json as string)).toEqual({
      sourceId: fixture.sourceId,
      reason: 'webhook',
    });
    expect(await fixture.rows('webhook_delivery')).toEqual([
      expect.objectContaining({
        org_id: fixture.org.orgId,
        outcome: 'processed',
      }),
    ]);
    expectPrivate(logged);
  });

  it('gives the same empty 404 for bad signatures and unavailable credentials, verifies every refusal, and enqueues nothing', async () => {
    const { fetch, fixture, verify, logged } = await boot();
    const cases = [
      [fixture.credentialId, 'incorrect-signature-secret'],
      ['unknown-credential', SECRET],
      [fixture.foreignCredential, SECRET],
      [fixture.wrongKind, SECRET],
      [fixture.projectCredential, SECRET],
      [fixture.malformed, SECRET],
      [fixture.corrupt, SECRET],
    ] as const;
    for (const [id, secret] of cases) {
      const response = await fetch(fixture.request(id, secret));
      expect(response.status, id).toBe(404);
      expect(await response.text()).toBe('');
      expect(response.headers.get('content-type')).toBeNull();
    }
    expect(verify).toHaveBeenCalledTimes(cases.length);
    for (const call of verify.mock.calls) expect(new TextDecoder().decode(call[2])).toBe(BODY);
    const dummySecrets = verify.mock.calls.slice(1).map(([material]) => material.token);
    expect(new Set(dummySecrets).size).toBe(1);
    expect(dummySecrets[0] === SECRET).toBe(false);
    const jobs = await fixture.rows('job');
    expect(jobs).toEqual([]);
    expect(await fixture.rows('webhook_delivery')).toEqual([]);
    expectPrivate(logged);
  });

  it.each(['missing', 'throwing'] as const)(
    'fails closed when the GitHub verifier is %s',
    async (mode) => {
      const { fetch, fixture, logged } = await boot({ mode });
      const response = await fetch(fixture.request());
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
      const jobs = await fixture.rows('job');
      expect(jobs).toEqual([]);
      expect(await fixture.rows('webhook_delivery')).toEqual([]);
      expectPrivate(logged);
    },
  );

  it('does not mount a webhook route without the job port', async () => {
    const { fetch, fixture, verify } = await boot({ jobs: false });
    expect((await fetch(fixture.request())).status).toBe(404);
    expect(verify).not.toHaveBeenCalled();
    const jobs = await fixture.rows('job');
    expect(jobs).toEqual([]);
    expect(await fixture.rows('webhook_delivery')).toEqual([]);
  });
});

function expectPrivate(logged: unknown[]) {
  const output = JSON.stringify(logged);
  for (const value of [
    SECRET,
    PRIVATE_KEY,
    '-----BEGIN PRIVATE KEY-----',
    'YWJjZA==',
    BODY,
    'request-body-that-must-never-be-logged',
  ]) {
    expect(output.includes(value)).toBe(false);
  }
}
