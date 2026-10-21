import type { ApiCall } from '../api/idempotency.js';
import { Buffer } from 'node:buffer';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ActorContext } from '../authz/administration.js';
import { mutationFence, type AuthenticatedActor } from '../authz/fence.js';
import type { ProjectActor } from '../authz/project-actor.js';
import { orgContext } from '../db/port.js';
import type { SourceRecord } from '../db/source.js';
import {
  createSourceService,
  type SourceService,
  type SourceServiceDeps,
} from './source-service.js';
import type { CredentialKind } from './credentials.js';
import * as urlPolicy from './url-policy.js';

const call: ApiCall = {
  audit: {
    opId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    sourceIp: '192.0.2.1',
    tokenSelector: null,
  },
};

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
    pause: vi.fn().mockResolvedValue('paused'),
    list: vi.fn().mockResolvedValue([]),
    getVisible: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue('deleted'),
  };
  const registeredNames = {
    list: vi.fn().mockResolvedValue({ items: [], next: null }),
    owner: vi.fn().mockResolvedValue({ sourceId: 'source', projectId: 'project-a' }),
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

describe('source visibility for mutation preflight', () => {
  const writer = {
    ...project,
    actor: { ...project.actor, permissions: new Set(['project:sources:write']) },
  };
  const target = { projectId: 'project-a', sourceId: 'source' };

  it.each(['project-owned', 'attached organization'] as const)(
    'returns a safe DTO for a %s source with write permission alone',
    async (owner) => {
      const { service, sources } = setup();
      sources.getVisible.mockResolvedValue({
        ...input,
        id: 'source',
        projectId: owner === 'project-owned' ? target.projectId : null,
        credentialId: 'hidden',
        configJson: 'hidden',
        lastError: 'hidden',
      } as SourceRecord);
      const result = await service.getVisible(ctx, writer, target);
      expect(result).toMatchObject({
        ok: true,
        value: {
          id: 'source',
          projectId: owner === 'project-owned' ? target.projectId : null,
          hasCredential: true,
        },
      });
      if (result.ok) {
        expect(result.value).not.toHaveProperty('credentialId');
        expect(result.value).not.toHaveProperty('configJson');
        expect(result.value).not.toHaveProperty('lastError');
      }
      expect(sources.getVisible).toHaveBeenCalledExactlyOnceWith(ctx, target);
      expect(sources.list).not.toHaveBeenCalled();
    },
  );

  it('returns not_found when the repository cannot resolve a visible source', async () => {
    const { service, sources } = setup();
    expect(await service.getVisible(ctx, writer, target)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(sources.getVisible).toHaveBeenCalledExactlyOnceWith(ctx, target);
  });

  it.each([
    { ...writer, actor: { ...writer.actor, permissions: new Set(['project:sources:read']) } },
    { ...writer, actor: { ...writer.actor, projectId: 'other-project' } },
    { ...writer, actor: { ...writer.actor, orgId: orgContext('other-org').orgId } },
    org,
  ])('denies an unauthorized actor before lookup (%#)', async (actor) => {
    const { service, sources } = setup();
    expect(await service.getVisible(ctx, actor, target)).toEqual({ ok: false, error: 'forbidden' });
    expect(sources.getVisible).not.toHaveBeenCalled();
  });
});

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
      await service.addRegisteredName(
        ctx,
        project,
        fence,
        {
          sourceId: 'source',
          pattern: 'vendor/*',
        },
        call,
      ),
    ).toMatchObject({ error: 'forbidden' });
    expect(await service.removeRegisteredName(ctx, project, fence, 'name', call)).toMatchObject({
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
      expect(
        await (operation === 'enable'
          ? service.enable(ctx, org, fence, 'source', call)
          : service[operation](ctx, org, fence, 'source')),
      ).toMatchObject({
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
        await service.addRegisteredName(
          ctx,
          org,
          fence,
          {
            sourceId: 'source',
            pattern: 'vendor/*',
          },
          call,
        )
      ).ok,
    ).toBe(true);
    expect((await service.removeRegisteredName(ctx, org, fence, 'name', call)).ok).toBe(true);
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

describe('registered-name mutation audit', () => {
  const idempotency: NonNullable<ApiCall['idempotency']> = {
    principalKey: 'user:user',
    key: 'operation',
    route: 'test',
    requestHash: 'hash',
    status: 200,
    responseJson: '{}',
    createdAt: '2026-10-19T00:00:00.000Z',
    expiresAt: '2026-10-20T00:00:00.000Z',
  };

  it('requires a trailing ApiCall on all three methods', () => {
    expectTypeOf<Parameters<SourceService['addRegisteredName']>['length']>().toEqualTypeOf<5>();
    expectTypeOf<Parameters<SourceService['removeRegisteredName']>['length']>().toEqualTypeOf<5>();
    expectTypeOf<Parameters<SourceService['enable']>['length']>().toEqualTypeOf<5>();
    expectTypeOf<Parameters<SourceService['addRegisteredName']>[4]>().toEqualTypeOf<ApiCall>();
    expectTypeOf<Parameters<SourceService['removeRegisteredName']>[4]>().toEqualTypeOf<ApiCall>();
    expectTypeOf<Parameters<SourceService['enable']>[4]>().toEqualTypeOf<ApiCall>();
  });

  it.each(['add', 'remove', 'enable'] as const)(
    'passes the %s event and preserves idempotency',
    async (operation) => {
      for (const record of [undefined, idempotency]) {
        const { service, registeredNames } = setup();
        const invocation = { ...call, ...(record === undefined ? {} : { idempotency: record }) };
        if (operation === 'add') {
          await service.addRegisteredName(
            ctx,
            org,
            fence,
            { sourceId: 'source', pattern: 'vendor/*' },
            invocation,
          );
        } else if (operation === 'remove') {
          await service.removeRegisteredName(ctx, org, fence, 'name', invocation);
        } else {
          await service.enable(ctx, org, fence, 'source', invocation);
        }
        const store = registeredNames[operation];
        expect(store).toHaveBeenCalledOnce();
        const [organization, guard, payload] = store.mock.calls[0]!;
        expect(organization).toBe(ctx);
        expect(guard).toBe(fence);
        expect(payload.audit).toMatchObject({
          action:
            operation === 'add'
              ? 'registered_name.add'
              : operation === 'remove'
                ? 'registered_name.remove'
                : 'source.resume',
          actor: { type: 'user', id: 'user' },
          target: {
            type: operation === 'enable' ? 'source' : 'registered_name',
            id: operation === 'remove' ? 'name' : 'source',
          },
          projectId: null,
          sourceIp: call.audit.sourceIp,
        });
        expect(JSON.parse(payload.audit.payloadJson)).toEqual({
          op_id: call.audit.opId,
          request_id: call.audit.requestId,
        });
        if (record === undefined) expect(Object.hasOwn(payload, 'idempotency')).toBe(false);
        else expect(payload.idempotency).toBe(record);
        expect(Object.values(payload).filter((value) => value === payload.audit)).toHaveLength(1);
        if (operation === 'remove') {
          expect(registeredNames.owner).toHaveBeenCalledExactlyOnceWith(ctx, 'name');
          expect(payload.pauseAudit).toMatchObject({
            action: 'source.pause',
            actor: { type: 'user', id: 'user' },
            target: { type: 'source', id: 'source' },
            projectId: 'project-a',
            sourceIp: call.audit.sourceIp,
          });
          expect(JSON.parse(payload.pauseAudit.payloadJson)).toEqual({
            op_id: call.audit.opId,
            request_id: call.audit.requestId,
          });
        } else expect(Object.hasOwn(payload, 'pauseAudit')).toBe(false);
      }
    },
  );

  it.each(['add', 'remove', 'enable'] as const)(
    'refuses forbidden %s before the store',
    async (operation) => {
      const { service, registeredNames } = setup();
      const denied = { ...org, actor: { ...org.actor, permissions: new Set<string>() } };
      const result =
        operation === 'add'
          ? await service.addRegisteredName(
              ctx,
              denied,
              fence,
              { sourceId: 'source', pattern: 'vendor/*' },
              call,
            )
          : operation === 'remove'
            ? await service.removeRegisteredName(ctx, denied, fence, 'name', call)
            : await service.enable(ctx, denied, fence, 'source', call);
      expect(result).toEqual({ ok: false, error: 'forbidden' });
      expect(registeredNames[operation]).not.toHaveBeenCalled();
      expect(registeredNames.owner).not.toHaveBeenCalled();
    },
  );

  it('refuses a project remove before looking up the owner', async () => {
    const { service, registeredNames } = setup();
    expect(await service.removeRegisteredName(ctx, project, fence, 'name', call)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(registeredNames.owner).not.toHaveBeenCalled();
    expect(registeredNames.remove).not.toHaveBeenCalled();
  });

  it('refuses an owner miss before remove reaches the store', async () => {
    const { service, registeredNames } = setup();
    registeredNames.owner.mockResolvedValue(null);
    expect(await service.removeRegisteredName(ctx, org, fence, 'missing', call)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(registeredNames.owner).toHaveBeenCalledExactlyOnceWith(ctx, 'missing');
    expect(registeredNames.remove).not.toHaveBeenCalled();
  });

  it('refuses an invalid pattern before the store', async () => {
    const { service, registeredNames } = setup();
    expect(
      await service.addRegisteredName(ctx, org, fence, { sourceId: 'source', pattern: '' }, call),
    ).toEqual({ ok: false, error: 'invalid_pattern' });
    expect(registeredNames.add).not.toHaveBeenCalled();
  });

  it('preserves the source project in a project actor enable audit event', async () => {
    const { service, sources, registeredNames } = setup();
    sources.get.mockResolvedValue({
      ...input,
      id: 'source',
      credentialId: null,
      projectId: 'project-a',
    } as SourceRecord);

    expect(await service.enable(ctx, project, fence, 'source', call)).toEqual({
      ok: true,
      value: null,
    });
    expect(registeredNames.enable).toHaveBeenCalledExactlyOnceWith(ctx, fence, {
      id: 'source',
      providerAnchors: [],
      audit: expect.objectContaining({
        action: 'source.resume',
        actor: { type: 'user', id: 'user' },
        target: { type: 'source', id: 'source' },
        projectId: 'project-a',
      }),
    });
  });

  it('refuses an absent source before enable reaches the store', async () => {
    const { service, sources, registeredNames } = setup();
    sources.get.mockResolvedValue(null);
    expect(await service.enable(ctx, org, fence, 'missing', call)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(registeredNames.enable).not.toHaveBeenCalled();
  });

  it.each(['add', 'remove', 'enable'] as const)(
    'rejects invalid audit input before %s reaches the store',
    async (operation) => {
      const { service, registeredNames } = setup();
      const invalid = { audit: { ...call.audit, requestId: 'invalid' } };
      const result =
        operation === 'add'
          ? service.addRegisteredName(
              ctx,
              org,
              fence,
              { sourceId: 'source', pattern: 'vendor/*' },
              invalid,
            )
          : operation === 'remove'
            ? service.removeRegisteredName(ctx, org, fence, 'name', invalid)
            : service.enable(ctx, org, fence, 'source', invalid);
      await expect(result).rejects.toThrow(new TypeError('Invalid source audit event'));
      expect(registeredNames[operation]).not.toHaveBeenCalled();
    },
  );
});

it.each([
  ['removed', false],
  ['removed_and_paused', true],
] as const)('preserves the %s outcome as paused: %s', async (answer, paused) => {
  const { service, registeredNames } = setup();
  registeredNames.remove.mockResolvedValue(answer);
  expect(await service.removeRegisteredName(ctx, org, fence, 'name', call)).toEqual({
    ok: true,
    value: { paused },
  });
  expect(registeredNames.remove).toHaveBeenCalledOnce();
});

describe('source list and pause', () => {
  const reader = {
    ...org,
    actor: { ...org.actor, permissions: new Set(['org:sources:read']) },
  };

  it('returns a safe DTO and an opaque continuation scoped to the organization and owner', async () => {
    const { service, sources } = setup();
    sources.list.mockResolvedValue([
      {
        ...input,
        id: 'a',
        credentialId: 'credential',
        url: 'https://user:secret@packages.example.com/path?token=secret#secret',
        status: 'active',
        removalPolicy: 'flag',
        pollIntervalSeconds: 60,
        lastSuccessAt: null,
        lastError: 'secret',
        configJson: '{"secret":"secret"}',
      },
      { ...input, id: 'b', credentialId: null },
    ]);
    const first = await service.list(ctx, reader, { cursor: null, limit: 1 });
    expect(first).toMatchObject({
      ok: true,
      value: {
        items: [{ id: 'a', hasCredential: true, url: 'https://packages.example.com/path' }],
      },
    });
    expect(JSON.stringify(first)).not.toMatch(/secret|credentialId|configJson|lastError/);
    if (!first.ok) throw new Error('expected page');
    expect(first.value.next).toEqual(expect.any(String));
    expect(first.value.next).not.toBe('a');
    sources.list.mockResolvedValue([]);
    expect(await service.list(ctx, reader, { cursor: first.value.next, limit: 1 })).toEqual({
      ok: true,
      value: { items: [], next: null },
    });
    expect(sources.list).toHaveBeenLastCalledWith(ctx, { projectId: null, after: 'a', limit: 1 });
    expect(
      await service.list(orgContext('org-b'), reader, { cursor: first.value.next, limit: 1 }),
    ).toMatchObject({ error: 'invalid_config' });
  });

  it.each([
    ['https://packages.example.com/repo;token=secret', 'https://packages.example.com/repo'],
    [
      'https://user:secret@packages.example.com/repo;token=secret/index;password=secret?token=secret#secret',
      'https://packages.example.com/repo/index',
    ],
    ['https://packages.example.com/token=secret/repo', null],
    ['https://packages.example.com/ghp_abcdefghijklmnop/repo', null],
    ['https://packages.example.com/%74oken%3Dsecret/repo', null],
    ['https://packages.example.com/repo%3Btoken%3Dsecret/index', null],
    ['https://packages.example.com/repo%3Ftoken%3Dsecret', null],
    ['https://packages.example.com/repo%23secret', null],
    ['https://packages.example.com/my%20packages', 'https://packages.example.com/my%20packages'],
    ['https://packages.example.com/caf%C3%A9', 'https://packages.example.com/caf%C3%A9'],
    ['https://packages.example.com/repo', 'https://packages.example.com/repo'],
    ['invalid', null],
    ['file:///repo;token=secret', null],
    [null, null],
  ])('sanitizes path credentials in source DTOs (%s)', async (url, expected) => {
    const { service, sources } = setup();
    sources.list.mockResolvedValue([{ ...input, id: 'source', url, credentialId: null }]);
    const result = await service.list(ctx, reader, { cursor: null, limit: 10 });
    expect(result).toMatchObject({ ok: true, value: { items: [{ url: expected }] } });
    expect(JSON.stringify(result)).not.toMatch(/secret|ghp_/);
  });

  it.each([false, true])('preserves optional pause idempotency (%s)', async (supplied) => {
    const { service, sources } = setup();
    const idempotency: NonNullable<ApiCall['idempotency']> = {
      principalKey: 'user:user',
      key: 'pause-operation',
      route: '/sources/source/pause',
      requestHash: 'a'.repeat(64),
      status: 200,
      responseJson: '{"ok":true}',
      createdAt: '2026-10-21T00:00:00.000Z',
      expiresAt: '2026-10-22T00:00:00.000Z',
    };
    expect(
      await service.pause(ctx, org, fence, 'source', {
        ...call,
        ...(supplied ? { idempotency } : {}),
      }),
    ).toEqual({ ok: true, value: null });
    const payload = sources.pause.mock.calls[0]![2];
    if (supplied) expect(payload.idempotency).toBe(idempotency);
    else expect(Object.hasOwn(payload, 'idempotency')).toBe(false);
  });

  it.each([0, 101, 1.5, NaN])('rejects invalid page limit %s', async (limit) => {
    const { service, sources } = setup();
    expect(await service.list(ctx, reader, { cursor: null, limit })).toMatchObject({
      error: 'invalid_config',
    });
    expect(sources.list).not.toHaveBeenCalled();
  });

  it('rejects malformed cursors without echoing them', async () => {
    const { service, sources } = setup();
    const answer = await service.list(ctx, reader, { cursor: 'secret', limit: 10 });
    expect(answer).toMatchObject({ error: 'invalid_config' });
    expect(JSON.stringify(answer)).not.toContain('secret');
    expect(sources.list).not.toHaveBeenCalled();
  });

  it('restricts project listing to the acting project and organization', async () => {
    const { service, sources } = setup();
    sources.list.mockResolvedValue([]);
    expect(
      (await service.list(ctx, project, { projectId: 'project-a', cursor: null, limit: 100 })).ok,
    ).toBe(true);
    expect(sources.list).toHaveBeenCalledWith(ctx, {
      projectId: 'project-a',
      after: null,
      limit: 100,
    });
    expect(
      await service.list(ctx, project, { projectId: 'project-b', cursor: null, limit: 1 }),
    ).toMatchObject({ error: 'forbidden' });
    expect(
      await service.list(orgContext('org-b'), project, {
        projectId: 'project-a',
        cursor: null,
        limit: 1,
      }),
    ).toMatchObject({ error: 'forbidden' });
    expect(sources.list).toHaveBeenCalledTimes(1);
  });

  it('requires read permission', async () => {
    const { service, sources } = setup();
    expect(await service.list(ctx, org, { cursor: null, limit: 10 })).toMatchObject({
      error: 'forbidden',
    });
    expect(sources.list).not.toHaveBeenCalled();
  });

  it('rejects reuse of a cursor under a different project', async () => {
    const { service, sources } = setup();
    sources.list.mockResolvedValue([
      { ...input, id: 'a', credentialId: null },
      { ...input, id: 'b', credentialId: null },
    ]);
    const page = await service.list(ctx, reader, { cursor: null, limit: 1 });
    if (!page.ok) throw new Error('expected page');
    expect(
      await service.list(ctx, project, {
        projectId: 'project-a',
        cursor: page.value.next,
        limit: 1,
      }),
    ).toMatchObject({ error: 'invalid_config' });
    expect(sources.list).toHaveBeenCalledTimes(1);
  });

  it('passes a pause audit and fence to the repository', async () => {
    const { service, sources } = setup();
    expect(await service.pause(ctx, org, fence, 'source', call)).toEqual({ ok: true, value: null });
    expect(sources.pause).toHaveBeenCalledWith(
      ctx,
      fence,
      expect.objectContaining({
        id: 'source',
        providerAnchors: [],
        audit: expect.objectContaining({
          action: 'source.pause',
          actor: { type: 'user', id: 'user' },
          target: { type: 'source', id: 'source' },
          projectId: null,
        }),
      }),
    );
  });

  it('lets a project writer pause an owned source without organization write permission', async () => {
    const { service, sources } = setup();
    const writer = {
      ...project,
      actor: { ...project.actor, permissions: new Set(['project:sources:write']) },
    };
    sources.get.mockResolvedValue({ ...input, id: 'source', projectId: 'project-a' });
    expect(await service.pause(ctx, writer, fence, 'source', call)).toEqual({
      ok: true,
      value: null,
    });
    expect(sources.pause).toHaveBeenCalledWith(
      ctx,
      fence,
      expect.objectContaining({
        audit: expect.objectContaining({ projectId: 'project-a' }),
      }),
    );
  });

  it.each([null, { ...input, id: 'source', projectId: 'project-b' }])(
    'hides missing or invisible pause targets %j',
    async (record) => {
      const { service, sources } = setup();
      sources.get.mockResolvedValue(record);
      expect(await service.pause(ctx, project, fence, 'source', call)).toEqual({
        ok: false,
        error: 'not_found',
      });
      expect(sources.pause).not.toHaveBeenCalled();
    },
  );

  it.each(['forbidden', 'conflict', 'indeterminate', 'not_found'])(
    'preserves pause error %s',
    async (error) => {
      const { service, sources } = setup();
      sources.pause.mockResolvedValue(error);
      expect(await service.pause(ctx, org, fence, 'source', call)).toEqual({ ok: false, error });
    },
  );

  it('requires write authority and a fence belonging to the actor', async () => {
    const { service, sources } = setup();
    expect(await service.pause(ctx, reader, fence, 'source', call)).toMatchObject({
      error: 'forbidden',
    });
    await expect(
      service.pause(ctx, org, { ...fence, userId: 'other' }, 'source', call),
    ).rejects.toThrow(TypeError);
    expect(sources.pause).not.toHaveBeenCalled();
  });
});

describe('registered-name listing', () => {
  const reader = { ...org, actor: { ...org.actor, permissions: new Set(['org:sources:read']) } };
  const query = { sourceId: 'source', limit: 1 };
  it('uses the org-scoped source lookup and returns the repository page', async () => {
    const { service, sources, registeredNames } = setup();
    const page = {
      items: [{ id: 'name', sourceId: 'source', ecosystem: 'composer', pattern: 'acme/*' }],
      next: 'name',
    };
    registeredNames.list.mockResolvedValue(page);
    expect(await service.listRegisteredNames(ctx, reader, query)).toEqual({
      ok: true,
      value: page,
    });
    expect(sources.get).toHaveBeenCalledWith(ctx, 'source');
    expect(registeredNames.list).toHaveBeenCalledWith(ctx, query);
  });
  it('uses the visibility lookup for the matching project reader', async () => {
    const { service, sources, registeredNames } = setup();
    sources.getVisible.mockResolvedValue({
      ...input,
      id: 'source',
      projectId: null,
      credentialId: null,
    } as SourceRecord);
    expect((await service.listRegisteredNames(ctx, project, query)).ok).toBe(true);
    expect(sources.getVisible).toHaveBeenCalledWith(ctx, {
      projectId: 'project-a',
      sourceId: 'source',
    });
    expect(sources.get).not.toHaveBeenCalled();
    expect(registeredNames.list).toHaveBeenCalledWith(ctx, query);
  });
  it.each(['absent', 'foreign', 'invisible', 'archived'])('hides a %s project source', async () => {
    const { service, registeredNames } = setup();
    expect(await service.listRegisteredNames(ctx, project, query)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(registeredNames.list).not.toHaveBeenCalled();
  });
  it('hides an absent organization source', async () => {
    const { service, sources, registeredNames } = setup();
    sources.get.mockResolvedValue(null);
    expect(await service.listRegisteredNames(ctx, reader, query)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(registeredNames.list).not.toHaveBeenCalled();
  });
  it.each([
    { ...reader, actor: { ...reader.actor, permissions: new Set<string>() } },
    { ...project, actor: { ...project.actor, orgId: orgContext('foreign').orgId } },
    { ...project, actor: { ...project.actor, permissions: new Set(['project:sources:write']) } },
  ])('denies unauthorized readers before a source lookup (%#)', async (actor) => {
    const { service, sources, registeredNames } = setup();
    expect(await service.listRegisteredNames(ctx, actor, query)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(sources.get).not.toHaveBeenCalled();
    expect(sources.getVisible).not.toHaveBeenCalled();
    expect(registeredNames.list).not.toHaveBeenCalled();
  });
  it.each([0, 101, 1.5, NaN])('rejects invalid page size %s', async (limit) => {
    const { service, registeredNames } = setup();
    expect(await service.listRegisteredNames(ctx, reader, { ...query, limit })).toMatchObject({
      ok: false,
      error: 'invalid_config',
    });
    expect(registeredNames.list).not.toHaveBeenCalled();
  });
});
