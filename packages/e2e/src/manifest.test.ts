import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manifestFilename, verifyManifest, writeManifest } from './manifest.js';
import type { ManifestInputs } from './manifest.js';

let root: string;
let build: string;
let other: string;
let inputs: ManifestInputs;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const recorded = () => join(build, manifestFilename);
const verify = (candidateInputs = inputs) => verifyManifest(recorded(), other, candidateInputs);

beforeEach(async () => {
  const scratch = fileURLToPath(new URL('../../../.pb/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, 't845-manifest-'));
  build = join(root, 'build');
  other = join(root, 'promoted');
  await mkdir(join(build, 'node/migrations/core'), { recursive: true });
  await mkdir(join(build, 'cloudflare/migrations/plugin'), { recursive: true });
  await writeFile(join(build, 'node/server.js'), 'console.log("node");\n');
  await writeFile(join(build, 'cloudflare/worker.js'), 'export default {};\n');
  await writeFile(join(build, 'node/migrations/core/0001.sql'), 'CREATE TABLE a (id TEXT);\n');
  await writeFile(
    join(build, 'cloudflare/migrations/plugin/0001.sql'),
    'CREATE TABLE b (id TEXT);\n',
  );
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  inputs = {
    sourceSha: 'a'.repeat(40),
    lockfilePath: join(root, 'pnpm-lock.yaml'),
    imageDigests: { 'ghcr.io/package-broker/node': `sha256:${'b'.repeat(64)}` },
  };
  await writeManifest(build, inputs);
  await cp(build, other, { recursive: true });
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('candidate manifest', () => {
  it('writes deterministic JSON binding the source, lockfile, migrations, bundles and image digests', async () => {
    const bytes = await readFile(recorded(), 'utf8');
    expect(JSON.parse(bytes)).toEqual({
      schemaVersion: 1,
      sourceSha: inputs.sourceSha,
      lockfileHash: hash('lockfileVersion: 9\n'),
      migrations: {
        'cloudflare/migrations/plugin/0001.sql': hash('CREATE TABLE b (id TEXT);\n'),
        'node/migrations/core/0001.sql': hash('CREATE TABLE a (id TEXT);\n'),
      },
      bundles: {
        'cloudflare/worker.js': hash('export default {};\n'),
        'node/server.js': hash('console.log("node");\n'),
      },
      imageDigests: inputs.imageDigests,
    });
    await writeManifest(build, inputs);
    expect(await readFile(recorded(), 'utf8')).toBe(bytes);
    await expect(verify()).resolves.toBeUndefined();
  });

  it.each([
    ['bundle byte', 'node/server.js', 'console.log("Node");\n'],
    ['migration byte', 'node/migrations/core/0001.sql', 'CREATE TABLE a (id INT);\n'],
    [
      'another runtime migration',
      'cloudflare/migrations/plugin/0001.sql',
      'CREATE TABLE c (id TEXT);\n',
    ],
    ['added bundle', 'node/extra.js', 'export {};\n'],
    ['added migration', 'node/migrations/core/0002.sql', 'CREATE TABLE c (id TEXT);\n'],
  ])('refuses a changed %s', async (_name, path, bytes) => {
    await writeFile(join(other, path), bytes);
    await expect(verify()).rejects.toThrow('CandidateManifestVerificationFailed');
  });

  it.each(['node/server.js', 'node/migrations/core/0001.sql'])(
    'refuses removal of %s',
    async (path) => {
      await rm(join(other, path));
      await expect(verify()).rejects.toThrow('CandidateManifestVerificationFailed');
    },
  );

  it('refuses a changed lockfile, source SHA or image digest', async () => {
    await expect(verify({ ...inputs, sourceSha: 'c'.repeat(40) })).rejects.toThrow(
      'CandidateManifestVerificationFailed',
    );
    await expect(
      verify({
        ...inputs,
        imageDigests: { 'ghcr.io/package-broker/node': `sha256:${'d'.repeat(64)}` },
      }),
    ).rejects.toThrow('CandidateManifestVerificationFailed');
    await writeFile(inputs.lockfilePath, 'lockfileVersion: 10\n');
    await expect(verify()).rejects.toThrow('CandidateManifestVerificationFailed');
  });

  it('compares JSON by content rather than formatting or key order', async () => {
    const value = JSON.parse(await readFile(recorded(), 'utf8')) as Record<string, unknown>;
    await writeFile(
      recorded(),
      JSON.stringify(Object.fromEntries(Object.entries(value).reverse())),
    );
    await expect(verify()).resolves.toBeUndefined();
  });

  it.each(['bad-json', 'unknown-version', 'missing-field', 'extra-field'])(
    'refuses %s manifest data',
    async (mutation) => {
      const value = JSON.parse(await readFile(recorded(), 'utf8')) as Record<string, unknown>;
      if (mutation === 'unknown-version') value.schemaVersion = 2;
      if (mutation === 'missing-field') delete value.lockfileHash;
      if (mutation === 'extra-field') value.unexpected = true;
      await writeFile(recorded(), mutation === 'bad-json' ? '{' : JSON.stringify(value));
      await expect(verify()).rejects.toThrow('CandidateManifestVerificationFailed');
    },
  );

  it.each([
    { sourceSha: 'branch-name' },
    { imageDigests: {} },
    { imageDigests: { node: 'latest' } },
    { imageDigests: { 'https://credential@example.invalid': `sha256:${'a'.repeat(64)}` } },
  ])('refuses incomplete or mutable candidate metadata: %j', async (patch) => {
    await expect(writeManifest(build, { ...inputs, ...patch })).rejects.toThrow(
      'CandidateManifestWriteFailed',
    );
  });

  it('fails closed on missing inputs and empty output', async () => {
    await expect(verify({ ...inputs, lockfilePath: join(root, 'missing') })).rejects.toThrow(
      'CandidateManifestVerificationFailed',
    );
    const empty = join(root, 'empty');
    await mkdir(empty);
    await expect(writeManifest(empty, inputs)).rejects.toThrow('CandidateManifestWriteFailed');
  });

  it('refuses to overwrite the lockfile with the manifest', async () => {
    const bytes = await readFile(recorded(), 'utf8');
    await expect(writeManifest(build, { ...inputs, lockfilePath: recorded() })).rejects.toThrow(
      'CandidateManifestWriteFailed',
    );
    expect(await readFile(recorded(), 'utf8')).toBe(bytes);
  });

  it('refuses symlink inputs and never includes filesystem errors in diagnostics', async () => {
    const target = join(other, 'node/server.js');
    await rm(target);
    await symlink(join(build, 'node/server.js'), target);
    await expect(verify()).rejects.toThrow(/^CandidateManifestVerificationFailed$/);
    await rm(recorded());
    await symlink(inputs.lockfilePath, recorded());
    await expect(writeManifest(build, inputs)).rejects.toThrow(/^CandidateManifestWriteFailed$/);
    expect(await readFile(inputs.lockfilePath, 'utf8')).toBe('lockfileVersion: 9\n');
  });
});
