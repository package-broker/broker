import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import {
  runImportPrivatePackagistFetch,
  type ImportPrivatePackagistOptions,
} from './import-private-packagist.js';

let dir: string;
let options: ImportPrivatePackagistOptions;
const key = 'SENTINEL_KEY';
const secret = 'SENTINEL_SECRET';
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-pp-command-'));
  await writeFile(join(dir, 'key'), key, { mode: 0o600 });
  await writeFile(join(dir, 'secret'), secret, { mode: 0o600 });
  options = {
    org: 'acme',
    snapshot: join(dir, 'snapshot.json'),
    apiKeyFile: join(dir, 'key'),
    apiSecretFile: join(dir, 'secret'),
    env: {},
    fetch: vi.fn(async () => Response.json([])),
  };
  stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  expect(JSON.stringify(stdout.mock.calls)).not.toContain(key);
  expect(JSON.stringify(stdout.mock.calls)).not.toContain(secret);
  expect(JSON.stringify(stderr.mock.calls)).not.toContain(key);
  expect(JSON.stringify(stderr.mock.calls)).not.toContain(secret);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

it('writes a confidential snapshot with only a count summary and no credentials', async () => {
  expect(await runImportPrivatePackagistFetch(options)).toBe(0);
  const text = await readFile(options.snapshot, 'utf8');
  expect(text).not.toContain(key);
  expect(text).not.toContain(secret);
  expect(stdout).toHaveBeenCalledWith('org_unverified');
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Confidential'));
  expect(await runImportPrivatePackagistFetch(options)).toBe(2);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('output_exists'));
  expect(await readFile(options.snapshot, 'utf8')).toBe(text);
});

it.each(['key', 'secret'])('refuses mode 0644 for the %s file before fetch', async (name) => {
  await chmod(join(dir, name), 0o644);
  expect(await runImportPrivatePackagistFetch(options)).toBe(2);
  expect(options.fetch).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('credential_file'));
  expect(await readdir(dir)).not.toContain('snapshot.json');
});

it('accepts stricter 0400 files and environment file paths', async () => {
  await chmod(join(dir, 'key'), 0o400);
  await chmod(join(dir, 'secret'), 0o400);
  const { apiKeyFile, apiSecretFile, ...rest } = options;
  expect(
    await runImportPrivatePackagistFetch({
      ...rest,
      env: { PP_API_KEY_FILE: apiKeyFile, PP_API_SECRET_FILE: apiSecretFile },
    }),
  ).toBe(0);
});

it.each(['key', 'secret'])(
  'refuses ambiguous flag and environment for %s even if paths match',
  async (name) => {
    expect(
      await runImportPrivatePackagistFetch({
        ...options,
        env: { [name === 'key' ? 'PP_API_KEY_FILE' : 'PP_API_SECRET_FILE']: join(dir, name) },
      }),
    ).toBe(2);
    expect(options.fetch).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('ambiguous_credentials'));
  },
);

it('refuses symlink, missing, oversized and non-regular credential files', async () => {
  await symlink(join(dir, 'secret'), join(dir, 'link'));
  await writeFile(join(dir, 'large'), 'x'.repeat(4097), { mode: 0o600 });
  for (const path of ['link', 'missing', 'large', '.'])
    expect(
      await runImportPrivatePackagistFetch({ ...options, apiSecretFile: join(dir, path) }),
    ).toBe(2);
  expect(options.fetch).not.toHaveBeenCalled();
});

it('keeps credentials out of network errors and diagnostic response bodies', async () => {
  for (const fetch of [
    async () => {
      throw new Error(`${key}:${secret}`);
    },
    async () => new Response(`${key} ${secret}`, { status: 401 }),
  ]) {
    expect(await runImportPrivatePackagistFetch({ ...options, fetch })).toBe(1);
  }
  expect(await readdir(dir)).not.toContain('snapshot.json');
});

it('does not write an unverified snapshot when --require-org-match is set', async () => {
  expect(await runImportPrivatePackagistFetch({ ...options, requireOrgMatch: true })).toBe(2);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('org_unverified'));
  expect(await readdir(dir)).not.toContain('snapshot.json');
});

it.each([
  [400, 'packagist_signature', 1],
  [401, 'packagist_auth', 1],
  [200, 'invalid_response', 2],
] as const)(
  'fails the entire fetch without partial output when a detail returns %s',
  async (status, code, exit) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/packages/')
        return Response.json([
          { id: 10, name: 'acme/first', origin: 'private', config: {} },
          { id: 11, name: 'acme/second', origin: 'private', config: {} },
        ]);
      if (path === '/api/packages/10/') return Response.json({ id: 10, versions: [] });
      if (path === '/api/packages/11/') return new Response(`${key} ${secret}`, { status });
      return Response.json([]);
    });
    expect(await runImportPrivatePackagistFetch({ ...options, versions: true, fetch })).toBe(exit);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(code));
    expect(stdout).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(
      expect.arrayContaining(['/api/packages/10/', '/api/packages/11/']),
    );
    expect((await readdir(dir)).sort()).toEqual(['key', 'secret']);
  },
);

it('dispatches fetch with flag and environment paths and rejects incomplete or unrelated flags', async () => {
  vi.stubGlobal('fetch', options.fetch);
  vi.stubEnv('PP_API_KEY_FILE', join(dir, 'key'));
  vi.stubEnv('PP_API_SECRET_FILE', join(dir, 'secret'));
  expect(
    await run([
      'import',
      'private-packagist',
      'fetch',
      '--org',
      'acme',
      '--snapshot',
      options.snapshot,
      '--versions',
    ]),
  ).toBe(0);
  for (const args of [
    ['import', 'private-packagist'],
    ['import', 'private-packagist', 'plan'],
    ['import', 'private-packagist', 'fetch', '--org', 'acme'],
    ['import', 'private-packagist', 'fetch', '--snapshot', options.snapshot],
    [
      'import',
      'private-packagist',
      'fetch',
      '--org',
      'acme',
      '--snapshot',
      options.snapshot,
      '--sqlite',
      'x',
    ],
    [
      'import',
      'private-packagist',
      'fetch',
      '--org',
      'acme',
      '--snapshot',
      options.snapshot,
      '--api-key',
      key,
    ],
  ])
    expect(await run(args)).toBe(2);
});

it('dispatches credential file flags and --require-org-match', async () => {
  vi.stubGlobal('fetch', options.fetch);
  vi.stubEnv('PP_API_KEY_FILE', undefined);
  vi.stubEnv('PP_API_SECRET_FILE', undefined);
  const args = [
    'import',
    'private-packagist',
    'fetch',
    '--org',
    'acme',
    '--snapshot',
    options.snapshot,
    '--api-key-file',
    join(dir, 'key'),
    '--api-secret-file',
    join(dir, 'secret'),
  ];
  expect(await run([...args, '--require-org-match'])).toBe(2);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('org_unverified'));
  expect(await run(args)).toBe(0);
});

it.each(['key', 'secret'])(
  'refuses the %s file when its owner differs from the current uid',
  async (name) => {
    const uid = process.getuid!();
    const getuid = vi.spyOn(process, 'getuid');
    if (name === 'secret') getuid.mockReturnValueOnce(uid);
    getuid.mockReturnValue(uid + 1);
    try {
      expect(
        await runImportPrivatePackagistFetch({
          ...options,
          [name === 'key' ? 'apiKeyFile' : 'apiSecretFile']: join(dir, name),
        }),
      ).toBe(2);
      expect(options.fetch).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('credential_file'));
      expect(await readdir(dir)).not.toContain('snapshot.json');
    } finally {
      getuid.mockRestore();
    }
  },
);

it.each(['key', 'secret'])(
  'refuses a short %s before network or snapshot serialization',
  async (name) => {
    await writeFile(join(dir, name), 'a');
    expect(await runImportPrivatePackagistFetch(options)).toBe(2);
    expect(options.fetch).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('credential_file'));
  },
);

it('refuses credential files on platforms without POSIX uid support', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid')!;
  Object.defineProperty(process, 'getuid', { ...descriptor, value: undefined });
  try {
    expect(await runImportPrivatePackagistFetch(options)).toBe(2);
    expect(options.fetch).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('credential_file'));
    expect(await readdir(dir)).not.toContain('snapshot.json');
  } finally {
    Object.defineProperty(process, 'getuid', descriptor);
  }
});

it('dispatches an offline plan, writes canonical private files, and prints counts only in quiet mode', async () => {
  const { stat } = await import('node:fs/promises');
  const { canonicalManifest, parseManifest } = await import('@package-broker/core/import/manifest');
  const snapshot = await readFile(
    new URL('../import/fixtures/private-packagist/plan-snapshot.json', import.meta.url),
    'utf8',
  );
  await writeFile(options.snapshot, snapshot, { mode: 0o600 });
  await writeFile(join(dir, 'map.json'), JSON.stringify({ version: 1, mirrorOrder: [20, 21] }));
  const fetch = vi.fn(() => {
    throw new Error('No network');
  });
  vi.stubGlobal('fetch', fetch);
  const out = join(dir, 'manifest.json');
  const credentials = join(dir, 'credentials.json');
  const args = [
    'import',
    'private-packagist',
    'plan',
    '--snapshot',
    options.snapshot,
    '--map',
    join(dir, 'map.json'),
    '--out',
    out,
    '--credentials-out',
    credentials,
    '--quiet',
  ];
  expect(await run(args)).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  const bytes = await readFile(out, 'utf8');
  const parsed = parseManifest(JSON.parse(bytes));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error('Expected manifest');
  expect(bytes).toBe(canonicalManifest(parsed.data));
  expect((await stat(out)).mode & 0o777).toBe(0o600);
  expect((await stat(credentials)).mode & 0o777).toBe(0o600);
  expect(stdout.mock.calls.map((call: unknown[]) => call[0])).toEqual([
    'create: 12',
    'existing: 0',
    'warning: 8',
    'needs-input: 5',
    'unsupported: 2',
  ]);
  const logs = JSON.stringify(stderr.mock.calls);
  for (const sentinel of [
    'acme/private',
    'example/artifact',
    'acme-user',
    'acme@example.test',
    'https://git.example.test',
  ])
    expect(logs).not.toContain(sentinel);
  expect(await run(args)).toBe(2);
  expect(stderr).toHaveBeenCalledWith('output_exists');
  expect(await readFile(out, 'utf8')).toBe(bytes);
});
it('refuses readable snapshots, warns for readable members, and leaves no partial output', async () => {
  const { runImportPrivatePackagistPlan } = await import('./import-private-packagist.js');
  const snapshot = await readFile(
    new URL('../import/fixtures/private-packagist/plan-snapshot.json', import.meta.url),
    'utf8',
  );
  await writeFile(options.snapshot, snapshot, { mode: 0o600 });
  const map = join(dir, 'map');
  await writeFile(map, '{"version":1,"mirrorOrder":[20,21]}');
  const out = join(dir, 'manifest');
  const credentialsOut = join(dir, 'credentials');
  await chmod(options.snapshot, 0o644);
  expect(
    await runImportPrivatePackagistPlan({ snapshot: options.snapshot, map, out, credentialsOut }),
  ).toBe(2);
  expect(stderr).toHaveBeenCalledWith('snapshot_permissions');
  await chmod(options.snapshot, 0o600);
  const members = join(dir, 'members.csv');
  await writeFile(members, 'username,email\nacme-user,acme@example.test', { mode: 0o644 });
  await writeFile(credentialsOut, 'retained', { mode: 0o600 });
  expect(
    await runImportPrivatePackagistPlan({
      snapshot: options.snapshot,
      map,
      out,
      credentialsOut,
      members,
    }),
  ).toBe(2);
  expect(await readdir(dir)).not.toContain('manifest');
  expect(await readFile(credentialsOut, 'utf8')).toBe('retained');
  await rm(credentialsOut);
  expect(
    await runImportPrivatePackagistPlan({
      snapshot: options.snapshot,
      map,
      out,
      credentialsOut,
      members,
    }),
  ).toBe(0);
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining('members_permissions'));
  expect(stdout).toHaveBeenCalledWith(expect.stringMatching(/^planHash: [a-f0-9]{64}$/));
});
it('does not leak snapshot, member or map values in refused stderr and quiet stdout', async () => {
  const { runImportPrivatePackagistPlan } = await import('./import-private-packagist.js');
  const snapshot = JSON.parse(
    await readFile(
      new URL('../import/fixtures/private-packagist/plan-snapshot.json', import.meta.url),
      'utf8',
    ),
  );
  const { canonical } = await import('../import/private-packagist/snapshot.js');
  const { createHash } = await import('node:crypto');
  snapshot.objects.packages[0].data.config.customJson = '{"name":"sentinel/private"}';
  snapshot.objects.packages[0].sha256 = createHash('sha256')
    .update(canonical(snapshot.objects.packages[0].data))
    .digest('hex');
  await writeFile(options.snapshot, JSON.stringify(snapshot), { mode: 0o600 });
  const map = join(dir, 'map');
  await writeFile(map, '{"version":1,"mirrorOrder":[20,21]}');
  const members = join(dir, 'members.csv');
  await writeFile(members, 'username,email\nsentinel-user,sentinel@example.test');
  expect(
    await runImportPrivatePackagistPlan({
      snapshot: options.snapshot,
      map,
      out: join(dir, 'out'),
      credentialsOut: join(dir, 'credentials'),
      members,
      quiet: true,
    }),
  ).toBe(2);
  expect(stderr).toHaveBeenCalledWith(
    expect.stringMatching(/^inline_package_unsupported \/packages\/\d+$/),
  );
  const diagnostics = JSON.stringify(stderr.mock.calls);
  for (const sentinel of [
    'acme/private',
    'example/artifact',
    'example/mirrored',
    'acme/suborganization-only',
    'acme-user',
    'sentinel/private',
    'sentinel-user',
    'sentinel@example.test',
    'git.example.test',
  ])
    expect(diagnostics).not.toContain(sentinel);
  for (const call of stdout.mock.calls)
    expect(call[0]).toMatch(/^(create|existing|warning|needs-input|unsupported): \d+$/);
  expect(await readdir(dir)).not.toContain('out');
});
it('accepts repeatable widening acknowledgements and refuses plan-only flag misuse', async () => {
  const { canonical } = await import('../import/private-packagist/snapshot.js');
  const { createHash } = await import('node:crypto');
  const snapshot = JSON.parse(
    await readFile(
      new URL('../import/fixtures/private-packagist/plan-snapshot.json', import.meta.url),
      'utf8',
    ),
  );
  const data = {
    id: 99,
    name: 'example/extra',
    origin: 'private-mirror',
    config: { mirroredRepositoryId: 20 },
  };
  snapshot.objects.packages.push({
    data,
    sha256: createHash('sha256').update(canonical(data)).digest('hex'),
  });
  snapshot.objects.suborganizationPackages = snapshot.objects.suborganizationPackages.filter(
    (e: { data: { origin: string } }) => e.data.origin !== 'private-mirror',
  );
  for (const suborganizationId of [1, 2]) {
    const scoped = {
      ...snapshot.objects.packages.find(
        (e: { data: { origin: string } }) => e.data.origin === 'private-mirror',
      ).data,
      suborganizationId,
    };
    snapshot.objects.suborganizationPackages.push({
      data: scoped,
      sha256: createHash('sha256').update(canonical(scoped)).digest('hex'),
    });
  }
  await writeFile(options.snapshot, JSON.stringify(snapshot), { mode: 0o600 });
  const map = join(dir, 'map');
  await writeFile(map, '{"version":1,"mirrorOrder":[20,21]}');
  const args = [
    'import',
    'private-packagist',
    'plan',
    '--snapshot',
    options.snapshot,
    '--map',
    map,
    '--out',
    join(dir, 'out'),
    '--credentials-out',
    join(dir, 'credentials'),
  ];
  expect(await run(args)).toBe(2);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('project_widening'));
  expect(
    await run([
      ...args,
      '--accept-project-widening',
      'acme',
      '--accept-project-widening',
      'example',
    ]),
  ).toBe(0);
  for (const flags of [
    ['--runtime', 'unknown'],
    ['--mode', 'unknown'],
    ['--org', 'acme'],
    ['--api-key-file', join(dir, 'key')],
  ])
    expect(await run([...args, ...flags])).toBe(2);
});
