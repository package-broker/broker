import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  canonicalManifest,
  MAX_MANIFEST_ITEMS,
  parseManifest,
  planHash,
} from '@package-broker/core/import/manifest';
import {
  planPrivatePackagistDates,
  type PrivatePackagistDatesInput,
  type PrivatePackagistDatesResult,
} from './dates.js';
import { planPrivatePackagistImport } from './plan.js';
import { canonical } from './snapshot.js';

const fixture = JSON.parse(
  await readFile(
    new URL('../fixtures/private-packagist/dates-snapshot.json', import.meta.url),
    'utf8',
  ),
);
const map = { version: 1, mirrorOrder: [30] };
const structure = await planPrivatePackagistImport({ snapshot: fixture, map });
if (!structure.ok) throw new Error(JSON.stringify(structure.diagnostics));
const baseline = structure.manifest;
const input = (): PrivatePackagistDatesInput => ({
  snapshot: structuredClone(fixture),
  map,
  baseline,
});
function rehash(snapshot: typeof fixture) {
  for (const entries of Object.values(snapshot.objects) as { data: unknown; sha256: string }[][])
    for (const entry of entries)
      entry.sha256 = createHash('sha256').update(canonical(entry.data)).digest('hex');
  return snapshot;
}
async function success(result: PrivatePackagistDatesResult) {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('Expected dates manifest');
  expect(parseManifest(JSON.parse(result.canonical)).ok).toBe(true);
  expect(result.canonical).toBe(canonicalManifest(result.manifest));
  expect(result.hash).toBe(await planHash(result.manifest));
  expect(result.manifest.items.every((item) => item.type === 'version_override')).toBe(true);
  expect(result.manifest.widening).toEqual([]);
  return result;
}
function refused(result: PrivatePackagistDatesResult, code: string, pointer?: string) {
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code, ...(pointer === undefined ? {} : { pointer }) }),
  );
}

it('emits source-release overrides, preserves Packagist version text and counts null dates once', async () => {
  const result = await success(await planPrivatePackagistDates(input()));
  expect(result.summary).toEqual({ overrides: 3, missingReleasedAt: 1 });
  const identity = ['https://git.example.test/acme/one', 'acme/one'];
  const ref = `pp:version:${createHash('sha256')
    .update(JSON.stringify(['pp-version-v1', identity, 'acme/one', 'v1.0.0']))
    .digest('hex')}`;
  const source = baseline.items.find(
    (item) =>
      item.type === 'source' &&
      'packageName' in item.config &&
      item.config.packageName === 'acme/one',
  );
  if (!source || source.type !== 'source') throw new Error('Expected source');
  expect(result.manifest.items).toContainEqual({
    type: 'version_override',
    external_ref: ref,
    source: { existing: { project: null, name: source.name } },
    package: 'acme/one',
    version: 'v1.0.0',
    published_at: '2020-01-02T00:34:05.123Z',
    basis: 'source_release',
  });
  expect(
    result.manifest.items.map((item) => item.type === 'version_override' && item.package).sort(),
  ).toEqual(['acme/one', 'acme/scoped', 'acme/two']);
});

it('is deterministic after shuffling snapshot rows and version arrays', async () => {
  const original = await success(await planPrivatePackagistDates(input()));
  const shuffled = structuredClone(fixture);
  for (const entries of Object.values(shuffled.objects) as { data: { versions?: unknown[] } }[][]) {
    entries.reverse();
    for (const entry of entries) entry.data.versions?.reverse();
  }
  const result = await success(await planPrivatePackagistDates({ ...input(), snapshot: shuffled }));
  expect(result.canonical).toBe(original.canonical);
  expect(result.hash).toBe(original.hash);
  expect(result.summary).toEqual(original.summary);
});

it.each([false, undefined])('refuses a snapshot without versions: true (%s)', async (versions) => {
  const snapshot = { ...fixture, versions };
  refused(
    await planPrivatePackagistDates({ ...input(), snapshot }),
    'versions_missing',
    '/versions',
  );
});

it.each(['bad version', '-1.0', 'x'.repeat(257), 'secret@example.test'])(
  'refuses invalid version text with a snapshot pointer (%s)',
  async (version) => {
    const snapshot = structuredClone(fixture);
    snapshot.objects.packageDetails[0].data.versions[0].version = version;
    const result = await planPrivatePackagistDates({ ...input(), snapshot: rehash(snapshot) });
    refused(result, 'invalid_version', '/objects/packageDetails/0/data/versions/0/version');
    expect(JSON.stringify(result.diagnostics)).not.toContain(version);
  },
);

it.each([null, undefined])(
  'validates version text before skipping a missing date (%s)',
  async (releasedAt) => {
    const snapshot = structuredClone(fixture);
    snapshot.objects.packageDetails[0].data.versions[0] = { version: 'bad version', releasedAt };
    refused(
      await planPrivatePackagistDates({ ...input(), snapshot: rehash(snapshot) }),
      'invalid_version',
      '/objects/packageDetails/0/data/versions/0/version',
    );
  },
);

it('refuses an incomplete baseline and uses the source name from the supplied baseline', async () => {
  const source = baseline.items.find(
    (item) =>
      item.type === 'source' &&
      'packageName' in item.config &&
      item.config.packageName === 'acme/one',
  );
  if (!source || source.type !== 'source') throw new Error('Expected source');
  const changed = {
    ...baseline,
    items: baseline.items.map((item) =>
      item === source ? { ...source, name: 'applied-source' } : item,
    ),
  };
  const result = await success(await planPrivatePackagistDates({ ...input(), baseline: changed }));
  expect(result.manifest.items).toContainEqual(
    expect.objectContaining({
      package: 'acme/one',
      source: { existing: { project: null, name: 'applied-source' } },
    }),
  );
  refused(
    await planPrivatePackagistDates({
      ...input(),
      baseline: { version: 1, source_system: 'private-packagist', items: [], widening: [] },
    }),
    'incomplete_baseline',
    '/objects/packageDetails/0/data',
  );
});

it.each(['private-mirror', 'private-proxy', 'public-mirror', 'public-proxy'])(
  'excludes %s versions even with release dates in the snapshot',
  async (origin) => {
    const snapshot = structuredClone(fixture);
    const pkg = snapshot.objects.packages.find(
      (entry: { data: { origin: string } }) => entry.data.origin === origin,
    ).data;
    const result = await success(await planPrivatePackagistDates({ ...input(), snapshot }));
    expect(result.manifest.items).not.toContainEqual(
      expect.objectContaining({ package: pkg.name }),
    );
    expect(result.summary).toEqual({ overrides: 3, missingReleasedAt: 1 });
  },
);

it('narrows output to the union of repeated package selections, including scoped-only packages', async () => {
  const result = await success(
    await planPrivatePackagistDates({
      ...input(),
      packages: ['acme/scoped', 'acme/one', 'acme/one'],
    }),
  );
  expect(result.manifest.items).toHaveLength(2);
  expect(result.summary).toEqual({ overrides: 2, missingReleasedAt: 1 });
});

it.each(['acme/unknown', 'example/p20', 'example/p21', 'example/p22', 'example/p23'])(
  'refuses a selector that matches no private package (%s)',
  async (selector) => {
    const result = await planPrivatePackagistDates({
      ...input(),
      packages: ['acme/one', selector],
    });
    refused(result, 'unknown_package', '/options/packages/1');
    expect(result.diagnostics).toContainEqual({
      code: 'unknown_package',
      pointer: '/options/packages/1',
      selector,
    });
  },
);

it('applies the byte cap at MAX_MANIFEST_ITEMS, the item cap above it and permits splitting by package', async () => {
  const snapshot = structuredClone(fixture);
  snapshot.objects.packageDetails = snapshot.objects.packageDetails.filter(
    (entry: { data: { id: number } }) => entry.data.id === 10 || entry.data.id === 11,
  );
  snapshot.objects.packageDetails[0].data.versions = Array.from(
    { length: MAX_MANIFEST_ITEMS },
    (_, i) => ({ version: `1.0.${i}`, releasedAt: '2020-01-01T00:00:00Z' }),
  );
  const boundary = await planPrivatePackagistDates({
    ...input(),
    snapshot: rehash(snapshot),
    packages: ['acme/one'],
  });
  refused(boundary, 'single_run_limit_exceeded');
  expect(boundary.diagnostics).toContainEqual(
    expect.objectContaining({ cap: 'MAX_MANIFEST_BYTES' }),
  );
  const over = await planPrivatePackagistDates({ ...input(), snapshot });
  refused(over, 'single_run_limit_exceeded');
  expect(over.diagnostics).toContainEqual(expect.objectContaining({ cap: 'MAX_MANIFEST_ITEMS' }));
  const split = await success(
    await planPrivatePackagistDates({ ...input(), snapshot, packages: ['acme/two'] }),
  );
  expect(split.manifest.items).toHaveLength(1);
});

it('uses the same URL mapping and normalization as the structure planner', async () => {
  const mapped = { ...map, packages: { 'acme/one': { url: 'https://github.com/Acme/Repo.git/' } } };
  const planned = await planPrivatePackagistImport({ snapshot: fixture, map: mapped });
  expect(planned.ok).toBe(true);
  if (!planned.ok) throw new Error('Expected structure');
  await success(
    await planPrivatePackagistDates({ snapshot: fixture, map: mapped, baseline: planned.manifest }),
  );
  refused(await planPrivatePackagistDates({ ...input(), map: mapped }), 'incomplete_baseline');
});

it.each([
  'not-a-date',
  '2020-01-01T00:00:00',
  '1969-01-01T00:00:00Z',
  '2020-02-30T00:00:00Z',
  '2020-01-01T24:00:00Z',
])('refuses invalid or ambiguous release dates with a pointer (%s)', async (releasedAt) => {
  const snapshot = structuredClone(fixture);
  snapshot.objects.packageDetails[0].data.versions[0].releasedAt = releasedAt;
  refused(
    await planPrivatePackagistDates({ ...input(), snapshot: rehash(snapshot) }),
    'invalid_released_at',
    '/objects/packageDetails/0/data/versions/0/releasedAt',
  );
});

it('rejects damaged snapshot hashes, malformed inputs and conflicting dates without echoing input', async () => {
  const snapshot = structuredClone(fixture);
  snapshot.objects.packages[0].data.name = 'sentinel/private';
  refused(await planPrivatePackagistDates({ ...input(), snapshot }), 'invalid_snapshot');
  refused(await planPrivatePackagistDates({ ...input(), snapshot: '{' }), 'invalid_snapshot');
  refused(await planPrivatePackagistDates({ ...input(), baseline: '{' }), 'invalid_baseline');
  refused(await planPrivatePackagistDates({ ...input(), map: { version: 2 } }), 'invalid_map');
  const conflict = structuredClone(fixture);
  const detail = structuredClone(conflict.objects.packageDetails[0]);
  detail.data.versions[0].releasedAt = '2020-02-01T00:00:00Z';
  conflict.objects.packageDetails.push(detail);
  refused(
    await planPrivatePackagistDates({ ...input(), snapshot: rehash(conflict) }),
    'conflicting_release_date',
  );
});

it('deduplicates repeated package details and counts absent dates as missing', async () => {
  const snapshot = structuredClone(fixture);
  snapshot.objects.packageDetails.push(structuredClone(snapshot.objects.packageDetails[0]));
  for (const entry of snapshot.objects.packageDetails)
    if (entry.data.id === 10) delete entry.data.versions[1].releasedAt;
  const result = await success(
    await planPrivatePackagistDates({ ...input(), snapshot: rehash(snapshot) }),
  );
  expect(result.summary).toEqual({ overrides: 3, missingReleasedAt: 1 });
});

it('refuses a missing private-package detail instead of silently omitting its versions', async () => {
  const snapshot = structuredClone(fixture);
  snapshot.objects.packageDetails = snapshot.objects.packageDetails.filter(
    (entry: { data: { id: number } }) => entry.data.id !== 12,
  );
  refused(
    await planPrivatePackagistDates({ ...input(), snapshot }),
    'invalid_snapshot',
    '/objects/packageDetails',
  );
});

it('refuses conflicting duplicate source URLs regardless of snapshot order', async () => {
  const snapshot = structuredClone(fixture);
  const conflicting = structuredClone(snapshot.objects.suborganizationPackages[0]);
  conflicting.data.config.url = 'https://git.example.test/acme/changed';
  snapshot.objects.suborganizationPackages.push(conflicting);
  refused(
    await planPrivatePackagistDates({ ...input(), snapshot: rehash(snapshot) }),
    'conflicting_source',
  );
  snapshot.objects.suborganizationPackages.reverse();
  refused(await planPrivatePackagistDates({ ...input(), snapshot }), 'conflicting_source');
});

it('does not echo arbitrary snapshot object keys in diagnostics', async () => {
  const snapshot = structuredClone(fixture);
  snapshot.objects['sentinel@example.test'] = [{ data: {}, sha256: 'damaged' }];
  const result = await planPrivatePackagistDates({ ...input(), snapshot });
  refused(result, 'invalid_snapshot', '/objects');
  expect(JSON.stringify(result.diagnostics)).not.toContain('sentinel@example.test');
});
