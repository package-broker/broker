import { readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PackagistApi } from './api.js';
import { canonical, fetchSnapshot, writeSnapshot } from './snapshot.js';

const fixturePath = new URL('../fixtures/private-packagist/pages.json', import.meta.url);
const key = 'SENTINEL_KEY';
const secret = 'SENTINEL_SECRET';
const now = () => new Date('2026-10-25T12:00:00Z');
type Pages = Record<string, unknown[]>;
const fixture = async (): Promise<Pages> =>
  JSON.parse(await readFile(fixturePath, 'utf8')) as Pages;
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function shuffle(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shuffle).reverse();
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, shuffle(child)]),
    );
  return value;
}
function client(pages: Pages, shuffled = false) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://packagist.com');
    const reply = (value: unknown, init?: ResponseInit) =>
      Response.json(shuffled ? shuffle(value) : value, init);
    const detailId = /^\/api\/packages\/(\d+)\/$/.exec(url.pathname)?.[1];
    if (detailId)
      return reply({
        id: Number(detailId),
        versions: [
          {
            version: '1.0.0',
            versionNormalized: '1.0.0.0',
            sourceReference: 'acme',
            distReference: null,
            releasedAt: null,
          },
          { version: '2.0.0', versionNormalized: '2.0.0.0', releasedAt: '2026-10-01T00:00:00Z' },
        ],
      });
    const rows = pages[url.pathname];
    if (!rows) throw new Error('Unexpected fixture endpoint');
    const ordered = shuffled ? [...rows].reverse() : rows;
    const index = Number(url.searchParams.get('page') ?? '1') - 1;
    const headers =
      index + 1 < ordered.length ? { link: `<${url.pathname}?page=${index + 2}>; rel="next"` } : {};
    return reply(ordered.slice(index, index + 1), { headers });
  });
  return { api: new PackagistApi({ key, secret, fetch }), fetch };
}

it('fetches all inventories, suborganization-only packages, wrapped mirrors and optional private versions', async () => {
  const { api, fetch } = client(await fixture());
  const { snapshot, notices } = await fetchSnapshot(api, { org: 'acme', versions: true, now });
  expect(notices).toEqual(['org_unverified']);
  expect(snapshot.objects.suborganizations).toHaveLength(2);
  expect(snapshot.objects.packages).toHaveLength(4);
  expect(snapshot.objects.suborganizationPackages).toHaveLength(3);
  expect(snapshot.objects.packageDetails?.map((entry) => entry.data.id).sort()).toEqual([
    10, 11, 12, 14,
  ]);
  expect(snapshot.objects.artifacts?.[0]?.data).toMatchObject({
    packageId: 11,
    id: 101,
    originalFileName: 'acme.zip',
  });
  expect(snapshot.objects.suborganizationMirroredRepositories?.[0]?.data).toEqual({
    id: 20,
    name: 'Acme',
    url: 'https://composer.example.test/',
    credentials: 40,
    mirroringBehavior: 'add_on_use',
    suborganizationId: 1,
  });
  expect(snapshot.objects.customers?.[0]?.data).toEqual({ id: 60 });
  expect(snapshot.objects.vendorBundles?.[0]?.data).toEqual({ id: 70 });
  const requested = fetch.mock.calls.map(([input]) => new URL(String(input)).pathname);
  expect(new Set(requested)).toEqual(
    new Set([
      ...Object.keys(await fixture()),
      '/api/packages/10/',
      '/api/packages/11/',
      '/api/packages/12/',
      '/api/packages/14/',
    ]),
  );
  for (const rows of Object.values(snapshot.objects))
    for (const entry of rows)
      expect(entry.sha256).toBe(createHash('sha256').update(canonical(entry.data)).digest('hex'));
});

it('writes identical canonical bytes and hashes for shuffled pages, arrays and field order', async () => {
  const pages = await fixture();
  const first = await fetchSnapshot(client(pages).api, { org: 'acme', versions: true, now });
  const second = await fetchSnapshot(client(pages, true).api, { org: 'acme', versions: true, now });
  const dir = await mkdtemp(join(tmpdir(), 'pb-pp-'));
  dirs.push(dir);
  await writeSnapshot(join(dir, 'one.json'), first.snapshot);
  await writeSnapshot(join(dir, 'two.json'), second.snapshot);
  expect(await readFile(join(dir, 'one.json'), 'utf8')).toBe(
    await readFile(join(dir, 'two.json'), 'utf8'),
  );
  expect((await stat(join(dir, 'one.json'))).mode & 0o777).toBe(0o600);
  await expect(writeSnapshot(join(dir, 'one.json'), second.snapshot)).rejects.toMatchObject({
    code: 'output_exists',
  });
  expect(await readdir(dir)).toEqual(['one.json', 'two.json']);
});

it('skips package detail requests without --versions', async () => {
  const { api, fetch } = client(await fixture());
  const result = await fetchSnapshot(api, { org: 'acme', now });
  expect(result.snapshot.objects.packageDetails).toEqual([]);
  expect(
    fetch.mock.calls.some(([input]) => /\/packages\/\d+\/$/.test(new URL(String(input)).pathname)),
  ).toBe(false);
});

it.each([undefined, false, true])('persists an explicit versions flag for %s', async (versions) => {
  const { snapshot } = await fetchSnapshot(client(await fixture()).api, {
    org: 'acme',
    ...(versions === undefined ? {} : { versions }),
    now,
  });
  const dir = await mkdtemp(join(tmpdir(), 'pb-pp-'));
  dirs.push(dir);
  const path = join(dir, 'snapshot.json');
  await writeSnapshot(path, snapshot);
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
    version: 1,
    versions: versions === true,
  });
});

it.each(['token', 'repository', 'suborganization-token'])(
  'verifies organization from %s URLs',
  async (source) => {
    const pages = await fixture();
    if (source === 'token')
      pages['/api/tokens/'] = [{ id: 1, url: 'https://repo.packagist.com/acme/' }];
    else if (source === 'suborganization-token')
      pages['/api/suborganizations/acme/tokens/'] = [
        { id: 2, url: 'https://repo.packagist.com/acme/acme/' },
      ];
    else
      pages['/api/suborganizations/'] = [
        {
          id: 1,
          name: 'Acme',
          urlName: 'acme',
          links: { repository: 'https://repo.packagist.com/acme/acme/' },
        },
      ];
    expect(
      (await fetchSnapshot(client(pages).api, { org: 'acme', requireOrgMatch: true, now })).notices,
    ).toEqual([]);
  },
);

it.each(['/api/tokens/', '/api/suborganizations/acme/tokens/'])(
  'refuses organization mismatches in %s',
  async (endpoint) => {
    const pages = await fixture();
    pages[endpoint] = [{ id: 1, url: 'https://repo.packagist.com/example/' }];
    await expect(fetchSnapshot(client(pages).api, { org: 'acme', now })).rejects.toMatchObject({
      code: 'org_mismatch',
    });
  },
);

it('refuses unverified organization under --require-org-match', async () => {
  await expect(
    fetchSnapshot(client(await fixture()).api, { org: 'acme', requireOrgMatch: true, now }),
  ).rejects.toMatchObject({ code: 'org_unverified' });
});

it('strips unknown secret, token and email fields recursively', async () => {
  const pages = await fixture();
  pages['/api/tokens/'] = [{ id: 1, token: secret, authorization: key }];
  pages['/api/credentials/'] = [
    { id: 1, type: 'http-basic', credential: secret, username: 'acme', email: 'acme@example.test' },
  ];
  pages['/api/teams/'] = [
    {
      id: 1,
      name: 'Acme',
      permission: 'view',
      members: [{ id: 1, username: 'acme', email: 'acme@example.test', secret }],
    },
  ];
  const text = canonical((await fetchSnapshot(client(pages).api, { org: 'acme', now })).snapshot);
  expect(text).not.toContain(secret);
  expect(text).not.toContain(key);
  expect(text).not.toContain('acme@example.test');
});

it.each([
  ['/api/packages/', [{ id: 'bad', name: 'Acme', origin: 'private', config: {} }]],
  ['/api/tokens/', [{ id: 1, url: 'https://key:secret@repo.example.test/acme' }]],
  ['/api/tokens/', [{ id: 1, url: 'https://repo.example.test/acme?token=secret' }]],
  [
    '/api/teams/',
    [
      {
        id: 1,
        name: 'Acme',
        permission: 'view',
        members: [{ id: 1, username: 'acme@example.test' }],
      },
    ],
  ],
  ['/api/tokens/', [{ id: 1, description: secret }]],
] as const)('rejects malformed or sensitive known fields in %s', async (endpoint, rows) => {
  const pages = await fixture();
  pages[endpoint] = [...rows];
  await expect(fetchSnapshot(client(pages).api, { org: 'acme', now })).rejects.toMatchObject({
    code: 'invalid_response',
  });
});

it('keeps synthetic fixtures free of emails, token prefixes and non-example hosts', async () => {
  const text = await readFile(fixturePath, 'utf8');
  expect(text).not.toMatch(/[^\s"@]+@[^\s"@]+\.[^\s"]+|packagist_/);
  for (const match of text.matchAll(/https?:\/\/[^\s"]+/g))
    expect(new URL(match[0]).hostname).toMatch(/\.example\.test$/);
});

it('fetches artifacts when duplicate package rows have partial or empty configuration', async () => {
  const pages = await fixture();
  pages['/api/suborganizations/acme/packages/']!.push({
    id: 11,
    name: 'example/artifact',
    origin: 'private',
    config: {},
  });
  const result = await fetchSnapshot(client(pages).api, { org: 'acme', now });
  expect(result.snapshot.objects.artifacts).toHaveLength(1);
  pages['/api/packages/'] = [
    { id: 11, name: 'example/artifact', origin: 'private', config: { type: 'artifact' } },
  ];
  expect(
    (await fetchSnapshot(client(pages).api, { org: 'acme', now })).snapshot.objects.artifacts,
  ).toHaveLength(1);
});

it('normalizes organization evidence URLs and refuses a mismatch after a matching token', async () => {
  const pages = await fixture();
  pages['/api/tokens/'] = [{ id: 1, url: 'https://REPO.PACKAGIST.COM:443/%61cme/' }];
  expect(
    (await fetchSnapshot(client(pages).api, { org: 'acme', requireOrgMatch: true, now })).notices,
  ).toEqual([]);
  pages['/api/suborganizations/acme/tokens/'] = [
    { id: 2, url: 'https://repo.packagist.com/example/acme/' },
  ];
  await expect(fetchSnapshot(client(pages).api, { org: 'acme', now })).rejects.toMatchObject({
    code: 'org_mismatch',
  });
});

it('refuses mismatching suborganization repository evidence', async () => {
  const pages = await fixture();
  pages['/api/suborganizations/'] = [
    {
      id: 1,
      name: 'Acme',
      urlName: 'acme',
      links: { repository: 'https://repo.packagist.com/example/acme/' },
    },
  ];
  await expect(fetchSnapshot(client(pages).api, { org: 'acme', now })).rejects.toMatchObject({
    code: 'org_mismatch',
  });
});

it.each(['acme', 'example'])(
  'does not use upstream mirror organization %s as evidence',
  async (org) => {
    const pages = await fixture();
    const mirror = { id: 90, name: 'Example', url: `https://repo.packagist.com/${org}/` };
    pages['/api/mirrored-repositories/'] = [mirror];
    pages['/api/suborganizations/acme/mirrored-repositories/'] = [
      { mirroringBehavior: 'manual', mirroredRepository: mirror },
    ];
    expect((await fetchSnapshot(client(pages).api, { org: 'acme', now })).notices).toEqual([
      'org_unverified',
    ]);
    await expect(
      fetchSnapshot(client(pages).api, { org: 'acme', now, requireOrgMatch: true }),
    ).rejects.toMatchObject({ code: 'org_unverified' });
    pages['/api/tokens/'] = [{ id: 1, url: 'https://repo.packagist.com/acme/' }];
    expect(
      (await fetchSnapshot(client(pages).api, { org: 'acme', now, requireOrgMatch: true })).notices,
    ).toEqual([]);
  },
);

it('retains unknown enum values as safe strings for offline planning', async () => {
  const pages = await fixture();
  pages['/api/packages/'] = [
    {
      id: 80,
      name: 'acme/future',
      origin: 'future-origin',
      config: { defaultSuborganizationAccess: 'future-access' },
    },
  ];
  pages['/api/teams/'] = [{ id: 81, name: 'Acme', permission: 'future-permission' }];
  pages['/api/credentials/'] = [{ id: 82, type: 'future-credential' }];
  pages['/api/mirrored-repositories/'] = [
    {
      id: 83,
      name: 'Acme',
      url: 'https://mirror.example.test/',
      mirroringBehavior: 'future-behavior',
    },
  ];
  pages['/api/suborganizations/acme/mirrored-repositories/'] = [
    {
      mirroringBehavior: 'future-sub-behavior',
      mirroredRepository: { id: 84, name: 'Acme', url: 'https://mirror.example.test/' },
    },
  ];
  const { snapshot } = await fetchSnapshot(client(pages).api, { org: 'acme', now });
  expect(snapshot.objects.packages?.[0]?.data).toMatchObject({
    origin: 'future-origin',
    config: { defaultSuborganizationAccess: 'future-access' },
  });
  expect(snapshot.objects.teams?.[0]?.data.permission).toBe('future-permission');
  expect(snapshot.objects.credentials?.[0]?.data.type).toBe('future-credential');
  expect(snapshot.objects.mirroredRepositories?.[0]?.data.mirroringBehavior).toBe(
    'future-behavior',
  );
  expect(snapshot.objects.suborganizationMirroredRepositories?.[0]?.data.mirroringBehavior).toBe(
    'future-sub-behavior',
  );
});

it('ignores null optional metadata without weakening required schemas', async () => {
  const pages = await fixture();
  pages['/api/credentials/'] = [
    { id: 40, type: 'http-basic', username: null, domain: null, description: null },
  ];
  pages['/api/packages/'] = [
    {
      id: 11,
      name: 'acme/artifact',
      origin: 'private',
      config: { type: 'artifact', artifactIds: null, defaultSuborganizationAccess: null },
      abandoned: null,
    },
  ];
  pages['/api/tokens/'] = [{ id: 1, description: null, url: null }];
  pages['/api/teams/'] = [
    {
      id: 1,
      name: 'Acme',
      permission: 'view',
      members: [{ id: 1, username: 'acme', remoteIds: null }],
    },
  ];
  pages['/api/synchronizations/'] = [
    { name: 'Acme', isPrimary: true, integration: { target: 'example', url: null } },
  ];
  pages['/api/packages/11/artifacts/'] = [
    { id: 101, version: '1.0.0', originalFileName: 'acme.zip', composerJson: null },
  ];
  const { snapshot } = await fetchSnapshot(client(pages).api, { org: 'acme', now });
  expect(snapshot.objects.credentials?.[0]?.data).toEqual({ id: 40, type: 'http-basic' });
  expect(snapshot.objects.artifacts?.[0]?.data).toEqual({
    id: 101,
    packageId: 11,
    version: '1.0.0',
    originalFileName: 'acme.zip',
  });
  pages['/api/teams/'] = [{ id: 1, name: null, permission: 'view' }];
  await expect(fetchSnapshot(client(pages).api, { org: 'acme', now })).rejects.toMatchObject({
    code: 'invalid_response',
  });
});

it('accepts versioned filenames and SSH descriptions while refusing account emails', async () => {
  const pages = await fixture();
  pages['/api/packages/11/artifacts/'] = [
    { id: 101, version: '1.0.0', originalFileName: 'pkg@1.0.0.zip' },
  ];
  pages['/api/tokens/'] = [{ id: 1, description: 'Deploy git@git.example.test:acme/repo' }];
  pages['/api/credentials/'] = [
    { id: 40, type: 'ssh-key', description: 'git@git.example.test:acme/repo' },
  ];
  pages['/api/synchronizations/'] = [
    { name: 'git@git.example.test:acme/repo', isPrimary: true, integration: { target: 'example' } },
  ];
  const { snapshot } = await fetchSnapshot(client(pages).api, { org: 'acme', now });
  expect(snapshot.objects.artifacts?.[0]?.data.originalFileName).toBe('pkg@1.0.0.zip');
  expect(snapshot.objects.tokens?.[0]?.data.description).toBe(
    'Deploy git@git.example.test:acme/repo',
  );
  pages['/api/tokens/'] = [{ id: 1, description: 'Contact acme@example.test' }];
  await expect(fetchSnapshot(client(pages).api, { org: 'acme', now })).rejects.toMatchObject({
    code: 'invalid_response',
  });
});

it.each([
  'git://git.example.test/acme/repo',
  'git+ssh://git@git.example.test/acme/repo',
  'ssh://acme@git.example.test/acme/repo',
  'svn://svn.example.test/acme/repo',
  'svn+ssh://acme@svn.example.test/acme/repo',
  'https://git.example.test/acme/repo?ref=main',
  'git@git.example.test:acme/repo',
])('retains Composer VCS URL %s', async (url) => {
  const pages = await fixture();
  pages['/api/packages/'] = [
    { id: 80, name: 'acme/vcs', origin: 'private', config: { type: 'vcs', url } },
  ];
  const { snapshot } = await fetchSnapshot(client(pages).api, { org: 'acme', now });
  expect(snapshot.objects.packages?.[0]?.data.config).toMatchObject({ url });
});

it.each([
  'file:///private/repo',
  'https://key:secret@git.example.test/repo',
  'https://git.example.test/repo?token=secret',
  'not a url',
])('drops only the repository row with a notice for URL %s', async (url) => {
  const pages = await fixture();
  pages['/api/packages/']!.push({
    id: 80,
    name: 'acme/unsafe',
    origin: 'private',
    config: { type: 'vcs', url },
  });
  pages['/api/mirrored-repositories/']!.push({ id: 90, name: 'Acme unsafe', url });
  const { snapshot, notices } = await fetchSnapshot(client(pages).api, { org: 'acme', now });
  expect(snapshot.objects.packages).toHaveLength(4);
  expect(snapshot.objects.mirroredRepositories).toHaveLength(2);
  expect(notices).toContain('repository_url_refused: 2');
  expect(canonical(snapshot)).not.toContain(url);
});

it.each(['SIGINT', 'SIGTERM'] as const)(
  'unlinks the temporary snapshot on %s and removes its signal handlers',
  async (signal) => {
    const dir = await mkdtemp(join(tmpdir(), 'pb-pp-signal-'));
    dirs.push(dir);
    const path = join(dir, 'snapshot.json');
    const probe = await open(join(dir, 'probe'), 'w');
    const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('unexpected process.exit');
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, reraised) => {
      expect(pid).toBe(process.pid);
      expect(reraised).toBe(signal);
      expect(readdirSync(dir)).toEqual(['probe']);
      expect(process.listenerCount(signal)).toBe(listeners[signal === 'SIGINT' ? 0 : 1]);
      throw new Error('test signal termination');
    });
    const sync = vi.spyOn(prototype, 'sync').mockImplementation(async () => {
      expect((await readdir(dir)).some((name) => name.startsWith('.pb-packagist-'))).toBe(true);
      process.emit(signal, signal);
    });
    try {
      const { snapshot } = await fetchSnapshot(client(await fixture()).api, { org: 'acme', now });
      await expect(writeSnapshot(path, snapshot)).rejects.toMatchObject({
        code: 'output_unwritable',
      });
      expect(kill).toHaveBeenCalledExactlyOnceWith(process.pid, signal);
      expect(exit).not.toHaveBeenCalled();
      expect(await readdir(dir)).toEqual(['probe']);
      expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(
        listeners,
      );
    } finally {
      sync.mockRestore();
      kill.mockRestore();
      exit.mockRestore();
    }
  },
);

it.each([
  'bad\0value',
  'bad\tvalue',
  'bad\nvalue',
  'bad\rvalue',
  'bad\x1fvalue',
  'bad\x7fvalue',
  'café',
  'acme@example.test',
  'x'.repeat(65),
])('drops unsafe enum rows while keeping valid neighbors: %j', async (permission) => {
  const pages = await fixture();
  pages['/api/teams/'] = [
    { id: 80, name: 'Acme unsafe', permission },
    { id: 81, name: 'Acme valid', permission: 'x'.repeat(64) },
    { id: 82, name: 'Acme future', permission: 'Future permission !~' },
    { id: 83, name: 'Acme empty', permission: '' },
  ];
  const { snapshot, notices } = await fetchSnapshot(client(pages).api, { org: 'acme', now });
  expect(snapshot.objects.teams?.map((entry) => entry.data.id)).toEqual([81, 82, 83]);
  expect(notices).toEqual(['enum_value_refused: 1', 'org_unverified']);
});

it('bounds every open enum and counts dropped rows per reason across inventories', async () => {
  const pages = await fixture();
  const unsafe = 'x'.repeat(65);
  pages['/api/packages/'] = [
    { id: 80, name: 'Acme', origin: unsafe, config: {} },
    { id: 81, name: 'Acme', origin: 'private', config: { type: unsafe } },
    { id: 82, name: 'Acme', origin: 'private', config: { defaultSuborganizationAccess: unsafe } },
    { id: 83, name: 'Acme', origin: 'private', config: { url: 'file:///private/repo' } },
  ];
  pages['/api/teams/'] = [{ id: 84, name: 'Acme', permission: unsafe }];
  pages['/api/tokens/'] = [{ id: 85, access: unsafe }];
  pages['/api/credentials/'] = [{ id: 86, type: unsafe }];
  pages['/api/synchronizations/'] = [
    { name: 'Acme', isPrimary: true, integration: { target: unsafe } },
  ];
  pages['/api/mirrored-repositories/'] = [
    { id: 87, name: 'Acme', url: 'https://mirror.example.test/', mirroringBehavior: unsafe },
    { id: 88, name: 'Acme', url: 'file:///private/mirror' },
  ];
  pages['/api/suborganizations/acme/mirrored-repositories/'] = [
    {
      mirroringBehavior: unsafe,
      mirroredRepository: { id: 89, name: 'Acme', url: 'https://mirror.example.test/' },
    },
    {
      mirroringBehavior: 'manual',
      mirroredRepository: { id: 90, name: 'Acme', url: 'file:///private/wrapped' },
    },
  ];
  const first = await fetchSnapshot(client(pages).api, { org: 'acme', now });
  const second = await fetchSnapshot(client(pages, true).api, { org: 'acme', now });
  expect(first.notices).toEqual([
    'enum_value_refused: 9',
    'org_unverified',
    'repository_url_refused: 3',
  ]);
  expect(second.notices).toEqual(first.notices);
  expect(first.snapshot.objects.packages).toEqual([]);
  expect(first.snapshot.objects.teams).toEqual([]);
  expect(first.snapshot.objects.mirroredRepositories).toEqual([]);
});

it.each(['keyword', 'monkey', 'authority'])(
  'retains public repository query key %s',
  async (queryKey) => {
    const pages = await fixture();
    const url = `https://git.example.test/repo?${queryKey}=public`;
    pages['/api/mirrored-repositories/'] = [{ id: 80, name: 'Acme', url }];
    const { snapshot, notices } = await fetchSnapshot(client(pages).api, { org: 'acme', now });
    expect(snapshot.objects.mirroredRepositories?.[0]?.data.url).toBe(url);
    expect(notices).toEqual(['org_unverified']);
  },
);

it.each([
  'token',
  'api_key',
  'access_token',
  'private_token',
  'secret_key',
  'access_key',
  'auth_key',
  'session_token',
  'oauth_token',
  'sig',
  'pwd',
  'PRIVATE-TOKEN',
  'private-token-v2',
  'client_secret',
  'password',
  'authorization',
  'signature',
  'credential',
  'X-Amz-Signature',
])('refuses credential repository query key %s', async (queryKey) => {
  const pages = await fixture();
  pages['/api/mirrored-repositories/'] = [
    { id: 80, name: 'Acme', url: `https://git.example.test/repo?${queryKey}=private` },
  ];
  const { snapshot, notices } = await fetchSnapshot(client(pages).api, { org: 'acme', now });
  expect(snapshot.objects.mirroredRepositories).toEqual([]);
  expect(notices).toEqual(['org_unverified', 'repository_url_refused: 1']);
});
