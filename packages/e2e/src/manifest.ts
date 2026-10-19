import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const manifestFilename = 'candidate-manifest.json';

export interface ManifestInputs {
  readonly sourceSha: string;
  readonly lockfilePath: string;
  readonly imageDigests: Readonly<Record<string, string>>;
}

export interface CandidateManifest {
  readonly schemaVersion: 1;
  readonly sourceSha: string;
  readonly lockfileHash: string;
  readonly migrations: Readonly<Record<string, string>>;
  readonly bundles: Readonly<Record<string, string>>;
  readonly imageDigests: Readonly<Record<string, string>>;
}

function invalid(): never {
  throw new Error('InvalidCandidateManifest');
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function ordered(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).sort(([left], [right]) => compare(left, right)));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function regularFile(path: string): Promise<Buffer> {
  if (!(await lstat(path)).isFile()) invalid();
  return readFile(path);
}

async function collect(buildDirectory: string, inputs: ManifestInputs): Promise<CandidateManifest> {
  if (resolve(inputs.lockfilePath) === resolve(buildDirectory, manifestFilename)) invalid();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(inputs.sourceSha)) invalid();
  const images = Object.entries(inputs.imageDigests);
  if (
    images.length === 0 ||
    images.some(
      ([name, value]) =>
        !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name) || !/^sha256:[a-f0-9]{64}$/.test(value),
    )
  )
    invalid();
  if (!(await lstat(buildDirectory)).isDirectory()) invalid();
  const migrations: [string, string][] = [];
  const bundles: [string, string][] = [];
  async function visit(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (relative === manifestFilename) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, `${relative}/`);
      } else {
        if (!entry.isFile()) invalid();
        if (resolve(path) === resolve(inputs.lockfilePath)) continue;
        const hash = digest(await regularFile(path));
        const collection =
          relative.split('/').includes('migrations') && relative.endsWith('.sql')
            ? migrations
            : bundles;
        collection.push([relative, hash]);
      }
    }
  }
  await visit(buildDirectory);
  if (migrations.length === 0 || !bundles.some(([name]) => /\.(?:c|m)?js$/.test(name))) invalid();
  return {
    schemaVersion: 1,
    sourceSha: inputs.sourceSha,
    lockfileHash: digest(await regularFile(inputs.lockfilePath)),
    migrations: ordered(Object.fromEntries(migrations)),
    bundles: ordered(Object.fromEntries(bundles)),
    imageDigests: ordered(inputs.imageDigests),
  };
}

export async function writeManifest(
  buildDirectory: string,
  inputs: ManifestInputs,
): Promise<CandidateManifest> {
  try {
    const manifest = await collect(buildDirectory, inputs);
    const destination = join(buildDirectory, manifestFilename);
    // Refuse a symlink at the reserved output path before opening it for writing.
    const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (existing && !existing.isFile()) invalid();
    await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch {
    throw new Error('CandidateManifestWriteFailed');
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compare(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// Inputs must come from the candidate being checked, not from the recorded manifest.
export async function verifyManifest(
  manifestPath: string,
  buildDirectory: string,
  inputs: ManifestInputs,
): Promise<void> {
  try {
    const recorded: unknown = JSON.parse((await regularFile(manifestPath)).toString('utf8'));
    const actual = await collect(buildDirectory, inputs);
    if (canonical(recorded) !== canonical(actual)) invalid();
  } catch {
    throw new Error('CandidateManifestVerificationFailed');
  }
}
