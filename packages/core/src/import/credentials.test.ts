import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AuditEvent } from '../audit/actions.js';
import {
  mutationFence,
  tokenMutationFence,
  type AuthenticatedActor,
  type AuthenticatedTokenActor,
} from '../authz/fence.js';
import { orgContext } from '../db/port.js';
import { type CredentialStore } from '../secrets/credential-store.js';
import {
  createImportCredentialService,
  type CredentialTarget,
  type ImportCredentialStore,
} from './credentials.js';

const ctx = orgContext('org');
const id = '01J0QPAD000000000000000000';
const fence = mutationFence({ userId: id, sessionId: 'session' } as AuthenticatedActor, {});
const token = tokenMutationFence(
  {
    tokenId: 'token',
    tokenKind: 'svc',
    principalId: id,
  } as AuthenticatedTokenActor,
  'org:import:write',
  {},
);
const sentinel = 'T528-sentinel-material-never-echo';
const material = JSON.stringify({ token: sentinel });
const input = {
  runId: id,
  externalRef: 'source',
  kind: 'bearer' as const,
  material,
  now: '2026-10-19T10:59:59.000Z',
  context: { opId: id, requestId: id, sourceIp: null, tokenSelector: null },
};
const sourceItem = {
  type: 'source',
  external_ref: 'source',
  name: 'private',
  ecosystem: 'composer',
  source_type: 'composer_repository',
  project: { existing: 'project' },
  url: 'https://packages.example.test/',
  credential_ref: 'env:REGISTRY_TOKEN',
  config: {
    selection: { packages: [], patterns: [], expandPatterns: false },
    distHosts: [],
    mirrorsFallback: false,
  },
};
const manifest = (items: unknown[] = [sourceItem]) =>
  JSON.stringify({ version: 1, source_system: 'test', items, widening: [] });
const outputs: unknown[] = [];
const audits: unknown[] = [];
const auditArguments: unknown[] = [];
const logger = ['log', 'warn', 'error', 'info', 'debug'] as const;
const logSpies = logger.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));

afterEach(() => {
  const text = JSON.stringify([
    outputs,
    audits,
    auditArguments,
    logSpies.map((spy) => spy.mock.calls),
  ]);
  expect(text).not.toContain(sentinel);
  expect(text).not.toContain(material);
  expect(text).not.toMatch(new RegExp(`\\b(${sentinel.length}|${material.length})\\b`));
  outputs.length = 0;
  audits.length = 0;
  auditArguments.length = 0;
  for (const spy of logSpies) spy.mockClear();
});

function setup(overrides: Partial<CredentialTarget> = {}, runtime: 'node' | 'cloudflare' = 'node') {
  const target: CredentialTarget = {
    approvedAt: '2026-10-19T10:00:00.000Z',
    credentialWindowUntil: '2026-10-19T11:00:00.000Z',
    manifest: manifest(),
    source: { id, projectId: id, credentialId: null },
    ...overrides,
  };
  const access = { target: target as CredentialTarget | null, allowed: true };
  const store = {
    inspect: vi.fn<ImportCredentialStore['inspect']>().mockImplementation(async () => access),
    setCredential: vi
      .fn<ImportCredentialStore['setCredential']>()
      .mockResolvedValue({ ok: true, results: [] }),
    bindings: vi
      .fn<ImportCredentialStore['bindings']>()
      .mockResolvedValue({ manifest: target.manifest, bound: [] }),
  };
  const sealedPlaintexts: string[] = [];
  const prepare = vi
    .fn<CredentialStore['prepare']>()
    .mockImplementation(async (_ctx, credential) => {
      sealedPlaintexts.push(new TextDecoder().decode(credential.plaintext));
      return { id, statement: { sql: 'sealed', params: [] } };
    });
  const auditStatement = vi.fn((_ctx, event: AuditEvent) => {
    audits.push(event);
    return { sql: 'audit', params: [event.payloadJson] };
  });
  const service = createImportCredentialService({
    store,
    credentials: { prepare },
    runtime,
    ids: { ulid: () => id },
    auditStatement,
  });
  const call = async (
    patch: Partial<Parameters<typeof service.acceptImportCredential>[2]> = {},
    who = fence as typeof fence | typeof token,
  ) => {
    const result = await service.acceptImportCredential(ctx, who, { ...input, ...patch });
    outputs.push(result);
    auditArguments.push(
      auditStatement.mock.calls,
      store.setCredential.mock.calls.map((args) => args[2].audit),
    );
    return result;
  };
  const refused = async (error: string, patch = {}) => {
    expect(await call(patch)).toEqual({ ok: false, error });
    expect(prepare).not.toHaveBeenCalled();
    expect(store.setCredential).not.toHaveBeenCalled();
    expect(auditStatement).not.toHaveBeenCalled();
  };
  return { access, store, prepare, sealedPlaintexts, auditStatement, call, refused, service };
}

describe('import credential window', () => {
  it('accepts a file credential reference', async () => {
    const h = setup({
      manifest: manifest([{ ...sourceItem, credential_ref: 'file:./registry-token' }]),
    });
    expect(await h.call()).toEqual({ ok: true, value: null });
    expect(h.sealedPlaintexts).toEqual([material]);
  });
  it('refuses the retired credential reference scheme before preparing or writing', async () => {
    await setup({
      manifest: manifest([
        { ...sourceItem, credential_ref: ['op', '//vault/item/token'].join(':') },
      ]),
    }).refused('unavailable');
  });
  it('accepts one second before expiry and requests exactly one audit in the fenced write', async () => {
    const h = setup();
    expect(await h.call()).toEqual({ ok: true, value: null });
    expect(h.sealedPlaintexts).toEqual([material]);
    expect(h.store.inspect).toHaveBeenCalledWith(ctx, fence, id, 'source', input.now);
    expect(h.prepare).toHaveBeenCalledExactlyOnceWith(ctx, {
      kind: 'bearer',
      projectId: id,
      plaintext: new Uint8Array(material.length),
    });
    expect(h.auditStatement).toHaveBeenCalledTimes(1);
    expect(audits[0]).toMatchObject({
      action: 'import_run.credential_set',
      target: { type: 'import_run', id },
      projectId: id,
      actor: { type: 'user', id },
    });
    expect(JSON.parse((audits[0] as AuditEvent).payloadJson)).toEqual({
      op_id: id,
      request_id: id,
      changes: { external_ref: { new: 'source' } },
    });
    expect(h.store.setCredential).toHaveBeenCalledExactlyOnceWith(ctx, fence, {
      runId: id,
      externalRef: 'source',
      sourceId: id,
      expected: {
        approvedAt: '2026-10-19T10:00:00.000Z',
        credentialWindowUntil: '2026-10-19T11:00:00.000Z',
      },
      credential: { id, statement: { sql: 'sealed', params: [] } },
      audit: { sql: 'audit', params: [(audits[0] as AuditEvent).payloadJson] },
      now: input.now,
    });
  });
  it('accepts a UUID external reference and preserves it in the credential audit', async () => {
    const externalRef = '550e8400-e29b-41d4-a716-446655440000';
    const h = setup({
      manifest: manifest([{ ...sourceItem, external_ref: externalRef }]),
    });
    expect(await h.call({ externalRef })).toEqual({ ok: true, value: null });
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.store.setCredential).toHaveBeenCalledTimes(1);
    expect(h.store.setCredential.mock.calls[0]?.[2].externalRef).toBe(externalRef);
    expect(h.auditStatement).toHaveBeenCalledTimes(1);
    expect(JSON.parse((audits[0] as AuditEvent).payloadJson)).toEqual({
      op_id: id,
      request_id: id,
      changes: { external_ref: { new: externalRef } },
    });
  });
  it('accepts a token fence and preserves caller bytes', async () => {
    const h = setup();
    const bytes = new TextEncoder().encode(material);
    expect(await h.call({ material: bytes }, token)).toEqual({ ok: true, value: null });
    expect(new TextDecoder().decode(bytes)).toBe(material);
    expect(audits[0]).toMatchObject({ actor: { type: 'service_principal', id } });
  });
  it('refuses an audit whose UUID external reference echoes the uploaded bearer token', async () => {
    const externalRef = '550e8400-e29b-41d4-a716-446655440000';
    await setup({
      manifest: manifest([{ ...sourceItem, external_ref: externalRef }]),
    }).refused('unavailable', {
      externalRef,
      material: JSON.stringify({ token: externalRef }),
    });
  });
  it('refuses an audit whose operation id echoes the uploaded bearer token', async () => {
    await setup().refused('unavailable', { material: JSON.stringify({ token: id }) });
  });
  it('refuses one second after expiry', async () => {
    await setup().refused('conflict', { now: '2026-10-19T11:00:01.000Z' });
  });
  it('refuses exactly at expiry', async () => {
    await setup().refused('conflict', { now: '2026-10-19T11:00:00.000Z' });
  });
  it('refuses before approval', async () => {
    await setup({ approvedAt: null }).refused('conflict');
  });
  it('hides an absent run even without permission', async () => {
    const h = setup();
    h.access.target = null;
    h.access.allowed = false;
    await h.refused('not_found');
  });
  it('refuses missing permission before manifest and window checks', async () => {
    const h = setup({ manifest: 'invalid', approvedAt: null });
    h.access.allowed = false;
    await h.refused('forbidden');
  });
  it('hides a non-source manifest item', async () => {
    await setup({
      manifest: manifest([
        { type: 'project', external_ref: 'source', slug: 'project', name: 'Project' },
      ]),
    }).refused('not_found');
  });
  it('hides an unknown manifest ref', async () => {
    await setup().refused('not_found', { externalRef: 'absent' });
  });
  it('hides a source without a credential ref', async () => {
    await setup({ manifest: manifest([{ ...sourceItem, credential_ref: null }]) }).refused(
      'not_found',
    );
  });
  it('refuses a source not created by apply', async () => {
    await setup({ source: null }).refused('conflict');
  });
  it('refuses an existing source credential', async () => {
    await setup({ source: { id, projectId: id, credentialId: id } }).refused('conflict');
  });
  it('refuses oversized strings before preparing or writing', async () => {
    await setup().refused('too_large', { material: 'x'.repeat(16385) });
  });
  it('counts UTF-8 bytes for the size cap', async () => {
    await setup().refused('too_large', { material: 'é'.repeat(8193) });
  });
  it('refuses oversized byte arrays', async () => {
    await setup().refused('too_large', { material: new Uint8Array(16385) });
  });
  it('refuses oversized byte arrays before copying caller bytes', async () => {
    const h = setup();
    const bytes = new Uint8Array(16385);
    const copy = vi.spyOn(Uint8Array, 'from');
    try {
      await h.refused('too_large', { material: bytes });
      expect(copy).not.toHaveBeenCalled();
    } finally {
      copy.mockRestore();
    }
  });
  it('refuses unparseable material', async () => {
    await setup().refused('invalid_credential', { material: sentinel });
  });
  it('refuses query credentials outside composer repositories', async () => {
    await setup({
      manifest: manifest([
        {
          ...sourceItem,
          ecosystem: 'npm',
          source_type: 'npm_registry',
          config: { scopes: ['@private'] },
        },
      ]),
    }).refused('invalid_credential', {
      kind: 'query',
      material: JSON.stringify({ param: 'token', value: sentinel }),
    });
  });
  const pem = '-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----\n';
  const github = JSON.stringify({ appId: '1', privateKeyPem: pem, webhookSecret: sentinel });
  it('refuses github_app outside GitHub VCS sources', async () => {
    await setup().refused('invalid_credential', { kind: 'github_app', material: github });
  });
  const vcs = {
    ...sourceItem,
    source_type: 'vcs',
    url: null,
    project: null,
    config: {
      provider: 'github',
      repository: 'owner/repo',
      installationId: null,
      packageName: null,
      refs: { tags: true, branches: [] },
    },
  };
  it('refuses github_app for project-owned manifest sources', async () => {
    await setup({ manifest: manifest([{ ...vcs, project: { existing: 'project' } }]) }).refused(
      'invalid_credential',
      { kind: 'github_app', material: github },
    );
  });
  it('accepts organization GitHub app material', async () => {
    expect(
      await setup({
        manifest: manifest([vcs]),
        source: { id, projectId: null, credentialId: null },
      }).call({ kind: 'github_app', material: github }),
    ).toEqual({ ok: true, value: null });
  });
  it('refuses ssh_key on cloudflare', async () => {
    await setup({}, 'cloudflare').refused('invalid_credential', {
      kind: 'ssh_key',
      material: JSON.stringify({ privateKeyPem: pem, knownHosts: 'host ssh-ed25519 YWJj' }),
    });
  });
  it.each([
    'not_found',
    'authority',
    'conflict',
    'collision',
    'unclassified',
    'indeterminate',
  ] as const)('maps fenced %s without returning batch results', async (reason) => {
    const h = setup();
    h.store.setCredential.mockResolvedValue({ ok: false, reason });
    const error =
      reason === 'authority'
        ? 'forbidden'
        : reason === 'collision'
          ? 'conflict'
          : ['unclassified', 'indeterminate'].includes(reason)
            ? 'unavailable'
            : reason;
    expect(await h.call()).toEqual({ ok: false, error });
  });
  it('answers unavailable when the stored manifest blob is missing', async () => {
    const h = setup();
    h.store.inspect.mockRejectedValue(new Error('import manifest unavailable'));
    expect(await h.call()).toEqual({ ok: false, error: 'unavailable' });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.store.setCredential).not.toHaveBeenCalled();
  });
  it('contains a sealing failure without logging its message', async () => {
    const h = setup();
    h.prepare.mockRejectedValue(new Error(sentinel));
    expect(await h.call()).toEqual({ ok: false, error: 'unavailable' });
    expect(h.store.setCredential).not.toHaveBeenCalled();
    expect(h.auditStatement).not.toHaveBeenCalled();
  });
});

describe('import credential binding status', () => {
  const plain = {
    ...sourceItem,
    external_ref: 'plain',
    name: 'public',
    url: 'https://public.example.test/',
    credential_ref: null,
  };
  const second = {
    ...sourceItem,
    external_ref: 'second',
    name: 'second',
    url: 'https://second.example.test/',
  };

  it('lists every credential-bearing source with its binding state and nothing else', async () => {
    const { store, service } = setup();
    store.bindings.mockResolvedValue({
      manifest: manifest([sourceItem, plain, second]),
      bound: ['second', 'plain'],
    });
    const result = await service.credentialStatus(ctx, id);
    if (!result.ok) throw new Error('status refused');
    expect([...result.value].sort((a, b) => a.sourceRef.localeCompare(b.sourceRef))).toEqual([
      { sourceRef: 'second', bound: true },
      { sourceRef: 'source', bound: false },
    ]);
    expect(JSON.stringify(result)).not.toContain('REGISTRY_TOKEN');
    expect(store.bindings).toHaveBeenCalledWith(ctx, id);
  });
  it('hides an absent or foreign run', async () => {
    const { store, service } = setup();
    store.bindings.mockResolvedValue(null);
    expect(await service.credentialStatus(ctx, id)).toEqual({ ok: false, error: 'not_found' });
  });
  it('reports no sources for a run without a stored manifest', async () => {
    const { store, service } = setup();
    store.bindings.mockResolvedValue({ manifest: null, bound: [] });
    expect(await service.credentialStatus(ctx, id)).toEqual({ ok: true, value: [] });
  });
  it('reports an unreadable stored manifest as unavailable', async () => {
    const { store, service } = setup();
    store.bindings.mockResolvedValue({ manifest: '{', bound: [] });
    expect(await service.credentialStatus(ctx, id)).toEqual({ ok: false, error: 'unavailable' });
    store.bindings.mockResolvedValue({ manifest: '{}', bound: [] });
    expect(await service.credentialStatus(ctx, id)).toEqual({ ok: false, error: 'unavailable' });
    store.bindings.mockResolvedValue('unavailable');
    expect(await service.credentialStatus(ctx, id)).toEqual({ ok: false, error: 'unavailable' });
  });
});
