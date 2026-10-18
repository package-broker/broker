import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../authz/administration.js';
import { mutationFence, type AuthenticatedActor } from '../authz/fence.js';
import type { ProjectActor } from '../authz/project-actor.js';
import { orgContext } from '../db/port.js';
import type { SourceRecord } from '../db/source.js';
import { createSourceService, type SourceServiceDeps } from './source-service.js';
import type { CredentialKind } from './credentials.js';
import * as urlPolicy from './url-policy.js';

const ctx = orgContext('org-a');
const org = {
  kind: 'org' as const,
  actor: {
    kind: 'organization',
    userId: 'user',
    isOrganizationAdmin: true,
    permissions: new Set(['org:sources:write', 'project:sources:read']),
  } satisfies ActorContext,
};
const project = {
  kind: 'project' as const,
  actor: {
    kind: 'project',
    userId: 'user',
    orgId: ctx.orgId,
    projectId: 'project-a',
    permissions: new Set(['project:sources:write', 'project:sources:read', 'org:sources:write']),
  } satisfies ProjectActor,
};
const fence = mutationFence({ userId: 'user', sessionId: 'session' } as AuthenticatedActor, {});
const input = {
  projectId: null,
  name: 'private',
  type: 'composer_repository' as const,
  ecosystem: 'composer' as const,
  url: 'https://packages.example.com',
  configJson: '{}',
};

function setup(runtime: 'node' | 'cloudflare' = 'node', allowPrivateHosts: string[] = []) {
  const sources = {
    create: vi.fn().mockResolvedValue('created'),
    update: vi.fn().mockResolvedValue('updated'),
    get: vi.fn().mockResolvedValue({
      ...input,
      id: 'source',
      credentialId: null,
    } as SourceRecord),
    resume: vi.fn().mockResolvedValue('resumed'),
    delete: vi.fn().mockResolvedValue('deleted'),
  };
  const registeredNames = {
    add: vi.fn().mockResolvedValue('added'),
    remove: vi.fn().mockResolvedValue('removed_and_paused'),
    enable: vi.fn().mockResolvedValue('enabled'),
  };
  const credentials = {
    prepare: vi
      .fn()
      .mockResolvedValue({ id: 'credential', statement: { sql: 'sealed', params: [] } }),
    put: vi.fn().mockResolvedValue('credential'),
  };
  const credentialRepository = { get: vi.fn().mockResolvedValue(null) };
  const catalogue = {
    previewWinners: vi.fn().mockResolvedValue([
      { sourceId: 'own', eligible: false, projectLevel: true },
      { sourceId: 'shared', eligible: true, projectLevel: false },
    ]),
  };
  const organizations = {
    get: vi.fn().mockResolvedValue({ settings: { retentionRemovedUpstreamDays: 365 } }),
  };
  const log = vi.fn();
  const service = createSourceService({
    sources,
    organizations,
    registeredNames,
    credentials,
    credentialRepository,
    catalogue,
    policy: { runtime, allowPrivateHosts, selfOrigins: ['https://broker.example.com'] },
    ids: { ulid: () => 'source' },
    providerAnchors: [],
    log,
  } satisfies SourceServiceDeps);
  return {
    service,
    sources,
    organizations,
    registeredNames,
    credentials,
    credentialRepository,
    catalogue,
    log,
  };
}

describe('source administration', () => {
  it('links an existing credential id without preparing a credential', async () => {
    const { service, sources, credentials, credentialRepository } = setup();
    credentialRepository.get.mockResolvedValue({ id: 'existing', projectId: null, kind: 'bearer' });
    expect((await service.create(ctx, org, fence, { ...input, credentialId: 'existing' })).ok).toBe(
      true,
    );
    expect(credentials.prepare).not.toHaveBeenCalled();
    expect(credentialRepository.get).toHaveBeenCalledWith(ctx, 'existing');
    const created = sources.create.mock.calls[0]?.[2] as { credential: unknown };
    expect(created.credential).toStrictEqual({ id: 'existing' });
    expect(created).not.toHaveProperty('credentialId');
  });

  it('refuses plaintext together with a credential id', async () => {
    const { service, sources, credentials } = setup();
    expect(
      await service.create(ctx, org, fence, {
        ...input,
        credential: { kind: 'bearer', plaintext: JSON.stringify({ token: 'long-enough-token' }) },
        credentialId: 'existing',
      }),
    ).toMatchObject({ ok: false, error: 'invalid_config', problems: [{ field: 'credential' }] });
    expect(sources.create).not.toHaveBeenCalled();
    expect(credentials.prepare).not.toHaveBeenCalled();
  });

  it.each([
    ['github_app', true],
    ['bearer', false],
  ] as const)('checks the kind of a linked GitHub App credential (%s)', async (kind, allowed) => {
    const { service, sources, credentialRepository } = setup();
    credentialRepository.get.mockResolvedValue({ id: 'existing', projectId: null, kind });
    const result = await service.create(ctx, org, fence, {
      ...input,
      type: 'vcs',
      url: null,
      configJson: JSON.stringify({ provider: 'github', repository: 'owner/name' }),
      credentialId: 'existing',
    });
    expect(result.ok).toBe(allowed);
    expect(credentialRepository.get).toHaveBeenCalledWith(ctx, 'existing');
    expect(sources.create).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (!allowed) expect(result).toEqual({ ok: false, error: 'credential_scope_mismatch' });
  });

  it('refuses a GitHub App credential for a project source', async () => {
    const { service, sources, credentialRepository } = setup();
    credentialRepository.get.mockResolvedValue({
      id: 'existing',
      projectId: null,
      kind: 'github_app',
    });
    expect(
      await service.create(ctx, project, fence, {
        ...input,
        projectId: 'project-a',
        type: 'vcs',
        url: null,
        configJson: JSON.stringify({ provider: 'github', repository: 'owner/name' }),
        credentialId: 'existing',
      }),
    ).toEqual({ ok: false, error: 'credential_scope_mismatch' });
    expect(credentialRepository.get).toHaveBeenCalledWith(ctx, 'existing');
    expect(sources.create).not.toHaveBeenCalled();
  });

  it('answers a missing GitHub App credential like a wrong kind', async () => {
    const { service, credentialRepository } = setup();
    const github = {
      ...input,
      type: 'vcs' as const,
      url: null,
      configJson: JSON.stringify({ provider: 'github', repository: 'owner/name' }),
      credentialId: 'existing',
    };
    credentialRepository.get.mockResolvedValue({ id: 'existing', projectId: null, kind: 'bearer' });
    const wrongKind = await service.create(ctx, org, fence, github);
    credentialRepository.get.mockResolvedValue(null);
    expect(await service.create(ctx, org, fence, github)).toEqual(wrongKind);
  });

  it.each([
    ['query', 'composer_repository', 'node', true],
    ['query', 'composer_repository', 'cloudflare', true],
    ['query', 'npm_registry', 'node', false],
    ['query', 'vcs', 'node', false],
    ['query', 'packagist_proxy', 'node', false],
    ['query', 'npmjs_proxy', 'node', false],
    ['ssh_key', 'composer_repository', 'node', true],
    ['ssh_key', 'composer_repository', 'cloudflare', false],
    ['github_app', 'composer_repository', 'node', false],
    ['github_app', 'npm_registry', 'node', false],
    ['github_app', 'vcs', 'node', false],
    ['github_app', 'packagist_proxy', 'node', false],
    ['github_app', 'npmjs_proxy', 'node', false],
  ] as const)('validates linked %s for %s on %s', async (kind, type, runtime, allowed) => {
    const { service, sources, credentials, credentialRepository } = setup(runtime);
    credentialRepository.get.mockResolvedValue({ id: 'existing', projectId: null, kind });
    const result = await service.create(ctx, org, fence, {
      ...input,
      type,
      ecosystem: type === 'npm_registry' || type === 'npmjs_proxy' ? 'npm' : 'composer',
      url: type === 'vcs' ? null : kind === 'query' ? `${input.url}?key=discarded` : input.url,
      configJson:
        type === 'vcs'
          ? JSON.stringify({ provider: 'git', repository: 'https://git.example.com/repo' })
          : '{}',
      credentialId: 'existing',
    });
    expect(credentialRepository.get).toHaveBeenCalledWith(ctx, 'existing');
    expect(credentials.prepare).not.toHaveBeenCalled();
    expect(sources.create).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (allowed) {
      expect(result).toMatchObject({ ok: true });
      expect(sources.create.mock.calls[0]?.[2]).toMatchObject({
        url: input.url,
        credential: { id: 'existing' },
      });
    } else {
      expect(result).toEqual({ ok: false, error: 'credential_scope_mismatch' });
    }
  });

  it('refuses missing credentials for a non-GitHub source before persistence', async () => {
    const { service, sources, credentialRepository } = setup();
    expect(await service.create(ctx, org, fence, { ...input, credentialId: 'missing' })).toEqual({
      ok: false,
      error: 'credential_scope_mismatch',
    });
    expect(credentialRepository.get).toHaveBeenCalledWith(ctx, 'missing');
    expect(sources.create).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'treats a null credentialId as absent (plaintext: %s)',
    async (plaintext) => {
      const { service, sources, credentials, credentialRepository } = setup();
      expect(
        await service.create(ctx, org, fence, {
          ...input,
          credentialId: null,
          ...(plaintext
            ? { credential: { kind: 'bearer' as const, plaintext: '{"token":"shared-token"}' } }
            : {}),
        }),
      ).toMatchObject({ ok: true });
      expect(credentialRepository.get).not.toHaveBeenCalled();
      expect(credentials.prepare).toHaveBeenCalledTimes(plaintext ? 1 : 0);
      expect(sources.create.mock.calls[0]?.[2]).toMatchObject({
        credential: plaintext ? { id: 'credential' } : null,
      });
    },
  );

  it('treats a null credentialId as absent when the source forbids credentials', async () => {
    const { service, sources, credentialRepository } = setup();
    expect(
      await service.create(ctx, org, fence, {
        ...input,
        type: 'npmjs_proxy',
        ecosystem: 'npm',
        url: 'https://registry.npmjs.org',
        credentialId: null,
      }),
    ).toMatchObject({ ok: true });
    expect(credentialRepository.get).not.toHaveBeenCalled();
    expect(sources.create.mock.calls[0]?.[2]).toMatchObject({ credential: null });
  });

  it.each([
    ['cloudflare', [], false],
    ['cloudflare', ['10.0.0.1'], false],
    ['node', [], false],
    ['node', ['10.0.0.1'], true],
  ] as const)('classifies private source URLs on %s with %j', async (runtime, hosts, allowed) => {
    const { service, sources } = setup(runtime, [...hosts]);
    const result = await service.create(ctx, org, fence, { ...input, url: 'https://10.0.0.1' });
    expect(result.ok).toBe(allowed);
    if (!allowed)
      expect(result).toMatchObject({ problems: [{ field: 'url', message: 'denied_by_policy' }] });
    expect(sources.create).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it('refuses denied dist hosts and self origins before persistence', async () => {
    const { service, sources } = setup();
    for (const change of [
      { configJson: '{"distHosts":["metadata.google.internal"]}' },
      { url: 'https://broker.example.com' },
    ]) {
      expect(await service.create(ctx, org, fence, { ...input, ...change })).toMatchObject({
        ok: false,
        problems: [{ message: 'denied_by_policy' }],
      });
    }
    expect(sources.create).not.toHaveBeenCalled();
  });

  it('allows project writes only to the actor owner, never registered-name edits', async () => {
    const { service, sources, registeredNames } = setup();
    expect(
      (await service.create(ctx, project, fence, { ...input, projectId: 'project-a' })).ok,
    ).toBe(true);
    sources.get.mockResolvedValue({
      ...input,
      id: 'source',
      projectId: 'project-a',
      credentialId: null,
    } as SourceRecord);
    expect((await service.update(ctx, project, fence, 'source', { url: input.url })).ok).toBe(true);
    expect(await service.create(ctx, project, fence, input)).toMatchObject({ error: 'forbidden' });
    expect(
      await service.create(ctx, project, fence, { ...input, projectId: 'project-b' }),
    ).toMatchObject({ error: 'forbidden' });
    expect(
      await service.addRegisteredName(ctx, project, fence, {
        sourceId: 'source',
        pattern: 'vendor/*',
      }),
    ).toMatchObject({ error: 'forbidden' });
    expect(await service.removeRegisteredName(ctx, project, fence, 'name')).toMatchObject({
      error: 'forbidden',
    });
    expect(registeredNames.add).not.toHaveBeenCalled();
    expect(registeredNames.remove).not.toHaveBeenCalled();
    sources.get.mockResolvedValue({
      ...input,
      id: 'source',
      projectId: 'project-b',
    } as SourceRecord);
    expect(await service.update(ctx, project, fence, 'source', {})).toMatchObject({
      error: 'not_found',
    });
  });

  it('previews only the authorized project through the visible-only reader', async () => {
    const { service, catalogue } = setup();
    const result = await service.preview(ctx, project, {
      projectId: 'project-a',
      ecosystem: 'composer',
      name: 'Vendor/Package',
    });
    expect(catalogue.previewWinners).toHaveBeenCalledWith(ctx, {
      projectId: 'project-a',
      ecosystem: 'composer',
      key: 'vendor/package',
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        winner: { sourceId: 'shared' },
        candidates: [{ sourceId: 'own' }, { sourceId: 'shared' }],
      },
    });
    expect(
      await service.preview(ctx, project, {
        projectId: 'project-b',
        ecosystem: 'npm',
        name: 'package',
      }),
    ).toMatchObject({ error: 'forbidden' });
    expect(
      await service.preview(
        ctx,
        { ...project, actor: { ...project.actor, permissions: new Set() } },
        { projectId: 'project-a', ecosystem: 'npm', name: 'package' },
      ),
    ).toMatchObject({ error: 'forbidden' });
    expect(
      await service.preview(ctx, project, {
        projectId: 'project-a',
        ecosystem: 'npm',
        name: '../bad',
      }),
    ).toMatchObject({ error: 'invalid_name' });
    expect(catalogue.previewWinners).toHaveBeenCalledTimes(1);
  });

  it('passes warnings through and logs only each field', async () => {
    const { service, log } = setup();
    const result = await service.create(ctx, org, fence, {
      ...input,
      configJson: '{"selection":{"patterns":["*/package"]}}',
    });
    expect(result).toMatchObject({ ok: true, warnings: [{ field: 'selection.patterns[0]' }] });
    expect(log).toHaveBeenCalledWith({
      level: 'info',
      event: 'source.config.warning',
      field: 'selection.patterns[0]',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('*/package');
  });

  it.each([
    'http_basic',
    'bearer',
    'header',
    'query',
    'github_app',
    'npm_token',
    'ssh_key',
  ] satisfies CredentialKind[])(
    'never persists plaintext in source fields or returns it for %s',
    async (kind) => {
      const { service, sources, log } = setup();
      const secret = 'sensitive-value-12345';
      const pem = '-----BEGIN PRIVATE KEY-----\nYWJjZGVmZ2g=\n-----END PRIVATE KEY-----';
      const values = {
        http_basic: { username: 'user', password: secret },
        bearer: { token: secret },
        header: { name: 'x-api-key', value: secret },
        query: { param: 'token', value: secret },
        github_app: { appId: '1', privateKeyPem: pem, webhookSecret: secret },
        npm_token: { token: secret },
        ssh_key: { privateKeyPem: pem, knownHosts: 'git.example.com ssh-ed25519 YWJjZGVmZ2g=' },
      };
      const result = await service.create(ctx, org, fence, {
        ...input,
        url: kind === 'query' ? `${input.url}?token=${secret}` : input.url,
        credential: { kind, plaintext: JSON.stringify(values[kind]) },
      });
      expect(result.ok).toBe(true);
      const output = JSON.stringify([sources.create.mock.calls, result, log.mock.calls]);
      expect(output).not.toContain(secret);
      expect(output).not.toContain('BEGIN PRIVATE KEY');
      expect(sources.create.mock.calls[0]?.[2]).toMatchObject({
        url: input.url,
        credential: { id: 'credential' },
      });
    },
  );

  it('rejects malformed credentials and invalid config before writing', async () => {
    const { service, sources, credentials } = setup();
    expect(
      await service.create(ctx, org, fence, {
        ...input,
        credential: { kind: 'bearer', plaintext: '{}' },
      }),
    ).toMatchObject({ error: 'invalid_config' });
    expect(await service.create(ctx, org, fence, { ...input, type: 'hosted' })).toMatchObject({
      error: 'invalid_config',
    });
    expect(credentials.prepare).not.toHaveBeenCalled();
    expect(sources.create).not.toHaveBeenCalled();
  });
});

describe('source administration regressions', () => {
  it.each([
    ['git@10.0.0.1:repo', [], false],
    ['git@10.0.0.1:repo', ['10.0.0.1'], false],
    ['git@10.0.0.1:repo', ['10.0.0.1:22'], true],
    ['ssh://git@10.0.0.1:2222/repo', ['10.0.0.1:22'], false],
    ['ssh://git@10.0.0.1:2222/repo', ['10.0.0.1:2222'], true],
    ['ssh://git@[fd00::1]:2222/repo', [], false],
    ['ssh://git@[fd00::1]:2222/repo', ['[fd00::1]:2222'], true],
    ['git@git.example.com:repo', [], true],
    ['ssh://git@git.example.com:2222/repo', [], true],
    ['ssh://git@broker.example.com:443/repo', [], false],
  ] as const)('classifies SSH destination %s with %j', async (repository, hosts, allowed) => {
    const { service, sources } = setup('node', [...hosts]);
    const vcs = {
      ...input,
      type: 'vcs' as const,
      url: null,
      configJson: JSON.stringify({ provider: 'ssh', repository }),
    };
    sources.get.mockResolvedValue({ ...vcs, id: 'source', credentialId: null } as SourceRecord);
    for (const operation of ['create', 'update'] as const) {
      const result =
        operation === 'create'
          ? await service.create(ctx, org, fence, vcs)
          : await service.update(ctx, org, fence, 'source', { configJson: vcs.configJson });
      expect(result.ok).toBe(allowed);
      if (!allowed)
        expect(result).toMatchObject({
          error: 'invalid_config',
          problems: [{ field: 'repository', message: 'denied_by_policy' }],
        });
      expect(sources[operation]).toHaveBeenCalledTimes(allowed ? 1 : 0);
    }
  });

  it('rejects an empty update before invoking the repository', async () => {
    const { service, sources, credentials } = setup();
    expect(await service.update(ctx, org, fence, 'source', {})).toMatchObject({
      ok: false,
      error: 'invalid_config',
      problems: [{ field: 'changes', message: 'must name one or more updatable source fields' }],
    });
    expect(sources.update).not.toHaveBeenCalled();
    expect(credentials.prepare).not.toHaveBeenCalled();
  });

  it.each(['create', 'update'] as const)(
    'preserves Buffer credential input on successful and refused %s',
    async (operation) => {
      for (const refused of [false, true]) {
        const { service, sources, credentials } = setup();
        sources[operation].mockResolvedValue(refused ? 'conflict' : `${operation}d`);
        const plaintext = Buffer.from(JSON.stringify({ token: 'replacement-token' }));
        const original = Uint8Array.from(plaintext);
        const credential = { kind: 'bearer' as const, plaintext };
        const result =
          operation === 'create'
            ? await service.create(ctx, org, fence, { ...input, credential })
            : await service.update(ctx, org, fence, 'source', { credential });
        expect(result.ok).toBe(!refused);
        expect(Uint8Array.from(plaintext)).toEqual(original);
        const temporary = credentials.prepare.mock.calls[0]?.[1].plaintext as Uint8Array;
        expect(temporary).not.toBe(plaintext);
        expect(temporary.every((byte) => byte === 0)).toBe(true);
      }
    },
  );

  it.each([
    ['cloudflare', [], false],
    ['cloudflare', ['10.0.0.1'], false],
    ['node', [], false],
    ['node', ['10.0.0.1'], true],
  ] as const)('classifies VCS repository policy on %s with %j', async (runtime, hosts, allowed) => {
    const { service, sources } = setup(runtime, [...hosts]);
    const vcs = {
      ...input,
      type: 'vcs' as const,
      url: null,
      configJson: JSON.stringify({ provider: 'git', repository: 'https://10.0.0.1/repo' }),
    };
    for (const operation of ['create', 'update'] as const) {
      sources.get.mockResolvedValue({ ...vcs, id: 'source', credentialId: null } as SourceRecord);
      const result =
        operation === 'create'
          ? await service.create(ctx, org, fence, vcs)
          : await service.update(ctx, org, fence, 'source', { configJson: vcs.configJson });
      expect(result.ok).toBe(allowed);
      if (!allowed)
        expect(result).toMatchObject({
          problems: [{ field: 'repository', message: 'denied_by_policy' }],
        });
    }
  });

  it('requires the project actor form for project source writes', async () => {
    const { service, sources, registeredNames } = setup();
    expect(
      await service.create(ctx, org, fence, { ...input, projectId: 'project-a' }),
    ).toMatchObject({ error: 'forbidden' });
    sources.get.mockResolvedValue({
      ...input,
      id: 'source',
      projectId: 'project-a',
    } as SourceRecord);
    expect(
      await service.update(ctx, org, fence, 'source', { pollIntervalSeconds: 600 }),
    ).toMatchObject({ error: 'not_found' });
    for (const operation of ['delete', 'resume', 'enable'] as const) {
      expect(await service[operation](ctx, org, fence, 'source')).toMatchObject({
        error: 'not_found',
      });
    }
    expect(sources.create).not.toHaveBeenCalled();
    expect(sources.update).not.toHaveBeenCalled();
    expect(sources.delete).not.toHaveBeenCalled();
    expect(sources.resume).not.toHaveBeenCalled();
    expect(registeredNames.enable).not.toHaveBeenCalled();
    expect(
      (
        await service.addRegisteredName(ctx, org, fence, {
          sourceId: 'source',
          pattern: 'vendor/*',
        })
      ).ok,
    ).toBe(true);
    expect((await service.removeRegisteredName(ctx, org, fence, 'name')).ok).toBe(true);
  });

  it('prepares replacement credentials for the fenced update and clears the temporary buffer', async () => {
    const { service, sources, credentials } = setup();
    sources.update.mockResolvedValue('conflict');
    const plaintext = new TextEncoder().encode(JSON.stringify({ token: 'replacement-token' }));
    expect(
      await service.update(ctx, org, fence, 'source', {
        credential: { kind: 'bearer', plaintext },
      }),
    ).toMatchObject({ error: 'conflict' });
    expect(credentials.put).not.toHaveBeenCalled();
    expect(credentials.prepare).toHaveBeenCalledOnce();
    expect(sources.update).toHaveBeenCalledWith(ctx, fence, {
      id: 'source',
      providerAnchors: [],
      changes: { credentialId: 'credential' },
      preparedCredential: { id: 'credential', statement: { sql: 'sealed', params: [] } },
    });
    expect(
      credentials.prepare.mock.calls[0]?.[1].plaintext.every((byte: number) => byte === 0),
    ).toBe(true);
    expect(plaintext.some((byte) => byte !== 0)).toBe(true);
  });

  it.each([
    { pollIntervalSeconds: 600 },
    { credential: null },
    {
      credential: {
        kind: 'bearer' as const,
        plaintext: JSON.stringify({ token: 'replacement-token' }),
      },
    },
  ])('preserves the supplied patch fields for %j', async (patch) => {
    const { service, sources } = setup();
    expect((await service.update(ctx, org, fence, 'source', patch)).ok).toBe(true);
    const changes = sources.update.mock.calls[0]?.[2].changes;
    expect(changes).not.toHaveProperty('url');
    expect(changes).not.toHaveProperty('configJson');
  });

  it('rejects oversized config before JSON parsing or URL classification', async () => {
    const { service, sources } = setup();
    const parse = vi.spyOn(JSON, 'parse');
    const classify = vi.spyOn(urlPolicy, 'classifyUrl');
    try {
      const result = await service.create(ctx, org, fence, {
        ...input,
        configJson: ' '.repeat(65537),
      });
      expect(result).toMatchObject({ problems: [{ field: 'config' }] });
      expect(parse).not.toHaveBeenCalled();
      expect(classify).not.toHaveBeenCalled();
      expect(sources.create).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
      classify.mockRestore();
    }
  });

  it('rejects oversized distHosts before classifying any entry', async () => {
    const { service, sources } = setup();
    const configJson = JSON.stringify({
      distHosts: Array.from({ length: 65 }, (_, i) => `host${i}.example.com`),
    });
    const classify = vi.spyOn(urlPolicy, 'classifyUrl');
    try {
      expect(
        await service.create(ctx, org, fence, { ...input, url: null, configJson }),
      ).toMatchObject({ problems: [{ field: 'distHosts' }] });
      expect(classify).not.toHaveBeenCalled();
      expect(sources.create).not.toHaveBeenCalled();
    } finally {
      classify.mockRestore();
    }
  });
});

describe('source write input bounds', () => {
  it.each(['create', 'update'] as const)(
    '%s bounds URLs before any preliminary work',
    async (operation) => {
      for (const credential of [
        undefined,
        { kind: 'query' as const, plaintext: '{"param":"key","value":"test"}' },
      ]) {
        const { service, sources, organizations, credentials } = setup();
        const classify = vi.spyOn(urlPolicy, 'classifyUrl');
        const parse = vi.spyOn(JSON, 'parse');
        try {
          const patch = {
            url: `https://packages.example.com/${'a'.repeat(2048)}?key=test`,
            ...(credential === undefined ? {} : { credential }),
          };
          const result =
            operation === 'create'
              ? await service.create(ctx, org, fence, { ...input, ...patch })
              : await service.update(ctx, org, fence, 'source', patch);
          expect(result).toMatchObject({
            ok: false,
            error: 'invalid_config',
            problems: [{ field: 'url' }],
          });
          expect(classify).not.toHaveBeenCalled();
          expect(parse).not.toHaveBeenCalled();
          expect(sources.get).not.toHaveBeenCalled();
          expect(organizations.get).not.toHaveBeenCalled();
          expect(credentials.prepare).not.toHaveBeenCalled();
          expect(sources.create).not.toHaveBeenCalled();
          expect(sources.update).not.toHaveBeenCalled();
        } finally {
          classify.mockRestore();
          parse.mockRestore();
        }
      }
    },
  );

  it.each(['create', 'update'] as const)(
    '%s validates numbers before reads, parsing or credential preparation',
    async (operation) => {
      for (const patch of [
        ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((pollIntervalSeconds) => ({
          pollIntervalSeconds,
        })),
        ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((retentionDaysOverride) => ({
          retentionDaysOverride,
        })),
      ]) {
        const { service, sources, organizations, credentials } = setup();
        const parse = vi.spyOn(JSON, 'parse');
        let result;
        try {
          const changes = {
            ...patch,
            credential: { kind: 'bearer' as const, plaintext: '{"token":"test"}' },
          };
          result =
            operation === 'create'
              ? await service.create(ctx, org, fence, { ...input, ...changes })
              : await service.update(ctx, org, fence, 'source', changes);
          expect(parse).not.toHaveBeenCalled();
        } finally {
          parse.mockRestore();
        }
        expect(result).toMatchObject({
          ok: false,
          error: 'invalid_config',
          problems: [{ field: Object.keys(patch)[0] }],
        });
        expect(sources.get).not.toHaveBeenCalled();
        expect(organizations.get).not.toHaveBeenCalled();
        expect(credentials.prepare).not.toHaveBeenCalled();
        expect(sources.create).not.toHaveBeenCalled();
        expect(sources.update).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['create', 'update'] as const)(
    '%s enforces organization retention for supplied overrides',
    async (operation) => {
      for (const retentionDaysOverride of [0, 364, 365, 366, null]) {
        const { service, sources, organizations, credentials } = setup();
        const patch = { retentionDaysOverride };
        const result =
          operation === 'create'
            ? await service.create(ctx, org, fence, { ...input, ...patch })
            : await service.update(ctx, org, fence, 'source', patch);
        const allowed = retentionDaysOverride === null || retentionDaysOverride >= 365;
        expect(result.ok).toBe(allowed);
        if (retentionDaysOverride !== null) expect(organizations.get).toHaveBeenCalledWith(ctx);
        if (!allowed) {
          expect(result).toMatchObject({
            error: 'invalid_config',
            problems: [{ field: 'retentionDaysOverride' }],
          });
          expect(credentials.prepare).not.toHaveBeenCalled();
        }
        expect(sources.create).toHaveBeenCalledTimes(allowed && operation === 'create' ? 1 : 0);
        expect(sources.update).toHaveBeenCalledTimes(allowed && operation === 'update' ? 1 : 0);
      }
    },
  );
});

it('checks URL length first when numeric fields are also invalid', async () => {
  const { service } = setup();
  expect(
    await service.create(ctx, org, fence, {
      ...input,
      url: 'x'.repeat(2049),
      pollIntervalSeconds: 0,
      retentionDaysOverride: -1,
    }),
  ).toMatchObject({ problems: [{ field: 'url' }] });
});

it('accepts a URL at the parser length limit and skips retention lookup when omitted', async () => {
  const { service, organizations } = setup();
  const prefix = 'https://packages.example.com/';
  expect(
    await service.create(ctx, org, fence, {
      ...input,
      url: prefix + 'a'.repeat(2048 - prefix.length),
      pollIntervalSeconds: 1,
    }),
  ).toMatchObject({ ok: true });
  expect(organizations.get).not.toHaveBeenCalled();
});

it('refuses supplied retention overrides when the organization is missing', async () => {
  const { service, sources, organizations } = setup();
  organizations.get.mockResolvedValue(null);
  expect(await service.create(ctx, org, fence, { ...input, retentionDaysOverride: 365 })).toEqual({
    ok: false,
    error: 'not_found',
  });
  expect(sources.create).not.toHaveBeenCalled();
});
