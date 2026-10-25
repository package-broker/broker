import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
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

it.each(['/api/tokens/', '/api/suborganizations/acme/tokens/', '/api/mirrored-repositories/'])(
  'refuses organization mismatches in %s',
  async (endpoint) => {
    const pages = await fixture();
    pages[endpoint] = endpoint.includes('mirrored')
      ? [{ id: 1, name: 'Example', url: 'https://repo.packagist.com/example/' }]
      : [{ id: 1, url: 'https://repo.packagist.com/example/' }];
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
  ['/api/teams/', [{ id: 1, name: 'Acme', permission: 'unexpected' }]],
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
