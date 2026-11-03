import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { CredentialRecord, CredentialRepository } from '../db/credentials.js';
import { orgContext, type OrgContext } from '../db/port.js';
import { fixedClock, ulid } from '../ids.js';
import { createSecretCipher, credentialAad } from '../secrets/cipher.js';
import { createCredentialStore } from '../secrets/credential-store.js';
import { createKeyring } from '../secrets/keyring.js';
import {
  NOTIFICATION_CREDENTIAL_KIND,
  NotificationCredentialError,
  createNotificationCredentials,
  type NotificationSecretConfiguration,
} from './credentials.js';
import { parseNotificationTemplate } from './template-schema.js';

const ORG = orgContext('01J00000000000000000000A0A');
const OTHER = orgContext('01J00000000000000000000B0B');
const SECRET: NotificationSecretConfiguration = {
  url: 'https://hooks.example.test/T000/B000/SENTINELPATHTOKEN?key=SENTINELQUERY',
  headers: [['Authorization', 'Bearer SENTINELHEADER']],
  signingKey: 'SENTINELSIGNINGKEY0000000000000000000000000',
  template: {
    text: '{"name":"{{package.name}}","marker":"SENTINELTEMPLATE"}',
    events: ['npm.package.published'],
  },
};

function key(version: number, start: number) {
  return { version, bytes: Uint8Array.from({ length: 32 }, (_, index) => start + index) };
}

type Row = CredentialRecord & { readonly orgId: string };

function memory(rows: Map<string, Row>): CredentialRepository {
  const visible = (ctx: OrgContext, id: string) => {
    const row = rows.get(id);
    return row !== undefined && row.orgId === ctx.orgId ? row : null;
  };
  return {
    insertStatement(ctx, row) {
      rows.set(row.id, { ...row, orgId: ctx.orgId });
      return { sql: 'INSERT INTO credential (id) VALUES (?)', params: [row.id] };
    },
    async insert(ctx, row) {
      rows.set(row.id, { ...row, orgId: ctx.orgId });
    },
    async get(ctx, id) {
      return visible(ctx, id);
    },
    async listBelowVersion(ctx, version) {
      return [...rows.values()].filter(
        (row) => row.orgId === ctx.orgId && row.sealed.keyVersion < version,
      );
    },
    async reseal(ctx, id, expectedVersion, sealed) {
      const row = visible(ctx, id);
      if (row === null || row.sealed.keyVersion !== expectedVersion) return false;
      rows.set(id, { ...row, sealed });
      return true;
    },
    async delete(ctx, id) {
      return rows.delete(id);
    },
  };
}

function setup(keys = [key(1, 1)], rows = new Map<string, Row>()) {
  const repository = memory(rows);
  const store = createCredentialStore({
    repository,
    cipher: createSecretCipher(createKeyring(keys), 'credential-encryption'),
    ids: { ulid },
    clock: fixedClock('2026-11-01T12:00:00.000Z'),
  });
  return { rows, store, credentials: createNotificationCredentials({ store, repository }) };
}

async function sealed(credentials = setup()) {
  const configuration = await credentials.credentials.prepare(
    ORG,
    { projectId: 'P1', endpointId: 'E1' },
    SECRET,
  );
  return { ...credentials, configuration };
}

describe('notification credentials', () => {
  it('seals one row for the project and opens it only with the same binding', async () => {
    const { rows, credentials, configuration } = await sealed();
    expect(configuration).toMatchObject({ headersConfigured: true, templateConfigured: true });
    expect(rows.get(configuration.credentialId)).toMatchObject({
      projectId: 'P1',
      kind: NOTIFICATION_CREDENTIAL_KIND,
      orgId: ORG.orgId,
    });
    const opened = await credentials.open(ORG, {
      credentialId: configuration.credentialId,
      projectId: 'P1',
      endpointId: 'E1',
    });
    expect([opened.url, opened.headers, opened.signingKey, opened.template]).toEqual([
      SECRET.url,
      SECRET.headers,
      SECRET.signingKey,
      parseNotificationTemplate(SECRET.template!.text, SECRET.template!.events),
    ]);
    expect(opened.template?.events).toEqual(['npm.package.published']);
  });

  it('refuses a sealed template whose text no longer fits its sealed selection', async () => {
    const { store, credentials } = setup();
    const { id } = await store.prepare(ORG, {
      kind: NOTIFICATION_CREDENTIAL_KIND,
      projectId: 'P1',
      plaintext: new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          endpointId: 'E1',
          projectId: 'P1',
          url: SECRET.url,
          headers: SECRET.headers,
          signingKey: SECRET.signingKey,
          template: {
            format: 'json-v1',
            events: ['npm.package.published'],
            text: '{"r":"{{data.releaseCause}}"}',
          },
        }),
      ),
    });
    await expect(
      credentials.open(ORG, { credentialId: id, projectId: 'P1', endpointId: 'E1' }),
    ).rejects.toThrow(NotificationCredentialError);
  });

  it('reports no configured headers or template for the canonical envelope', async () => {
    const { credentials } = setup();
    expect(
      await credentials.prepare(
        ORG,
        { projectId: 'P1', endpointId: 'E1' },
        { ...SECRET, headers: [], template: null },
      ),
    ).toMatchObject({ headersConfigured: false, templateConfigured: false });
  });

  it.each([
    ['another organization', OTHER, { projectId: 'P1', endpointId: 'E1' }],
    ['another project', ORG, { projectId: 'P2', endpointId: 'E1' }],
    ['another endpoint', ORG, { projectId: 'P1', endpointId: 'E2' }],
  ] as const)('refuses %s', async (_label, ctx, binding) => {
    const { credentials, configuration } = await sealed();
    await expect(
      credentials.open(ctx, { credentialId: configuration.credentialId, ...binding }),
    ).rejects.toThrow(NotificationCredentialError);
  });

  it('refuses another credential kind and a swapped AAD before decrypting', async () => {
    const { rows, credentials, configuration } = await sealed();
    const row = rows.get(configuration.credentialId)!;
    const binding = { credentialId: row.id, projectId: 'P1', endpointId: 'E1' };
    rows.set(row.id, { ...row, kind: 'npm-notification-body' });
    await expect(credentials.open(ORG, binding)).rejects.toThrow(NotificationCredentialError);
    rows.set(row.id, {
      ...row,
      aad: credentialAad({ id: row.id, orgId: OTHER.orgId, kind: row.kind }),
    });
    await expect(credentials.open(ORG, binding)).rejects.toThrow(NotificationCredentialError);
    rows.set(row.id, row);
    await expect(credentials.open(ORG, binding)).resolves.toBeDefined();
  });

  it('refuses a same-project credential sealed for another endpoint', async () => {
    const { rows, credentials, configuration } = await sealed();
    const other = await credentials.prepare(ORG, { projectId: 'P1', endpointId: 'E2' }, SECRET);
    expect(rows.size).toBe(2);
    await expect(
      credentials.open(ORG, {
        credentialId: other.credentialId,
        projectId: 'P1',
        endpointId: 'E1',
      }),
    ).rejects.toThrow(NotificationCredentialError);
    await expect(
      credentials.open(ORG, {
        credentialId: configuration.credentialId,
        projectId: 'P1',
        endpointId: 'E1',
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a row of another project even when its plaintext names this project', async () => {
    const { store, credentials } = setup();
    const { id } = await store.prepare(ORG, {
      kind: NOTIFICATION_CREDENTIAL_KIND,
      projectId: 'P2',
      plaintext: new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          endpointId: 'E1',
          projectId: 'P1',
          url: SECRET.url,
          headers: SECRET.headers,
          signingKey: SECRET.signingKey,
          template: SECRET.template,
        }),
      ),
    });
    await expect(
      credentials.open(ORG, { credentialId: id, projectId: 'P1', endpointId: 'E1' }),
    ).rejects.toThrow(NotificationCredentialError);
  });

  it('opens the same plaintext after master-key resealing', async () => {
    const first = await sealed(setup([key(1, 1)]));
    const rotated = setup([key(2, 101), key(1, 1)], first.rows);
    expect(await rotated.store.resealBatch(ORG, { afterId: null, limit: 10 })).toMatchObject({
      resealed: 1,
    });
    expect(first.rows.get(first.configuration.credentialId)?.sealed.keyVersion).toBe(2);
    const opened = await rotated.credentials.open(ORG, {
      credentialId: first.configuration.credentialId,
      projectId: 'P1',
      endpointId: 'E1',
    });
    expect(opened.url).toBe(SECRET.url);
    expect(opened.signingKey).toBe(SECRET.signingKey);
  });

  it('never prints or serializes the configuration or echoes it in errors', async () => {
    const { credentials, configuration } = await sealed();
    const opened = await credentials.open(ORG, {
      credentialId: configuration.credentialId,
      projectId: 'P1',
      endpointId: 'E1',
    });
    const leaks = [
      JSON.stringify(opened),
      JSON.stringify(configuration.statement),
      inspect(opened, { showHidden: false }),
      String(Object.keys(opened)),
      JSON.stringify({ ...opened }),
    ];
    for (const output of leaks) expect(output).not.toMatch(/SENTINEL/);
    const failure = await credentials
      .open(ORG, { credentialId: configuration.credentialId, projectId: 'P1', endpointId: 'E9' })
      .catch((error: unknown) => error as Error);
    expect(failure).toBeInstanceOf(NotificationCredentialError);
    expect(`${String(failure)} ${(failure as Error).stack ?? ''}`).not.toMatch(/SENTINEL|E9|P1/);
  });

  it.each([
    ['a non-string URL', { url: 1 }],
    ['seventeen headers', { headers: Array.from({ length: 17 }, () => ['X-A', 'b']) }],
    ['a malformed header', { headers: [['X-A']] }],
    ['a scalar template', { template: 'x' }],
    [
      'a template invalid for its selection',
      { template: { text: '{"r":"{{data.releaseCause}}"}', events: ['npm.package.published'] } },
    ],
    ['a template without its selection', { template: { text: '{"n":"{{package.name}}"}' } }],
    [
      'an oversized configuration',
      { headers: Array.from({ length: 16 }, () => ['X-A', 'x'.repeat(3_000)]) },
    ],
  ])('refuses %s before sealing', async (_label, change) => {
    const { rows, credentials } = setup();
    await expect(
      credentials.prepare(ORG, { projectId: 'P1', endpointId: 'E1' }, {
        ...SECRET,
        ...change,
      } as NotificationSecretConfiguration),
    ).rejects.toThrow(NotificationCredentialError);
    expect(rows.size).toBe(0);
  });
});
