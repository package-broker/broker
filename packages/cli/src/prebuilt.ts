import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { CloudflareError, type CommandEnvelope } from './commands/cloudflare/api.js';
import { validateDeploymentArtifact } from './commands/cloudflare/deploy.js';

const PACKAGE = '@package-broker/dist-cloudflare';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const invalid = (): never => {
  throw new CloudflareError('prebuilt_invalid', 2, false, 'prebuilt');
};
const unsafe = (): never => {
  throw new CloudflareError('unsafe_path', 2, false, 'prebuilt');
};
const mismatch = (): never => {
  throw new CloudflareError('checksum_mismatch', 3, false, 'prebuilt');
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, names: readonly string[]) {
  if (
    Object.keys(value).length !== names.length ||
    names.some((name) => !Object.hasOwn(value, name))
  )
    invalid();
}
function pathParts(name: string): string[] {
  if (isAbsolute(name) || name.includes('\\') || name.includes('\0') || name.includes(':'))
    return unsafe();
  const parts = name.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return unsafe();
  return parts;
}
const deploymentFile = (name: string) =>
  ['worker.js', 'build-info.json', 'generated/manifest.json', 'assets.json'].includes(name) ||
  name.startsWith('assets/') ||
  name.startsWith('migrations/');
async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function regular(root: string, name: string): Promise<Buffer> {
  let current = root;
  const parts = pathParts(name);
  for (const [index, part] of parts.entries()) {
    current = resolvePath(current, part);
    const entry = await stat(current);
    if (!entry) return mismatch();
    if (
      entry.isSymbolicLink() ||
      (index === parts.length - 1 ? !entry.isFile() : !entry.isDirectory())
    )
      return unsafe();
  }
  return readFile(current);
}
function record(value: unknown) {
  const r = object(value);
  keys(r, [
    'schemaVersion',
    'package',
    'version',
    'target',
    'payload',
    'gitSha',
    'lockfileSha256',
    'toolchain',
    'plugins',
    'files',
    'artifactSha256',
  ]);
  if (
    r.schemaVersion !== 1 ||
    r.package !== PACKAGE ||
    r.target !== 'cloudflare' ||
    r.payload !== 'cloudflare' ||
    typeof r.version !== 'string' ||
    typeof r.gitSha !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(r.gitSha) ||
    !digest(r.lockfileSha256) ||
    !digest(r.artifactSha256)
  )
    return invalid();
  const toolchain = object(r.toolchain);
  keys(toolchain, ['node', 'esbuild', 'os', 'arch']);
  if (
    Object.values(toolchain).some((v) => typeof v !== 'string') ||
    Object.values(object(r.plugins)).some((v) => typeof v !== 'string')
  )
    invalid();
  const files = object(r.files);
  for (const [name, value] of Object.entries(files)) {
    pathParts(name);
    if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) invalid();
    if (!deploymentFile(name) && name !== 'wrangler.toml') invalid();
  }
  for (const name of [
    'worker.js',
    'build-info.json',
    'generated/manifest.json',
    'assets.json',
    'assets/manifest.json',
  ])
    if (!Object.hasOwn(files, name)) mismatch();
  return {
    ...r,
    files,
    version: r.version,
    gitSha: r.gitSha,
    lockfileSha256: r.lockfileSha256,
    artifactSha256: r.artifactSha256,
  };
}

export interface PrebuiltExpected {
  schemaVersion: 1;
  package: string;
  version: string;
  artifactSha256: string;
  prebuiltJsonSha256: string;
}
export interface MaterializePrebuiltOptions {
  project: string;
  outDir?: string;
  cliVersion?: string;
  expected?: PrebuiltExpected;
  resolve?: (specifier: string) => string;
}
export interface PrebuiltMaterialization {
  outDir: string;
  package: string;
  version: string;
  gitSha: string;
  artifactSha256: string;
}
export function prebuiltEnvelope(
  result: PrebuiltMaterialization,
): NonNullable<CommandEnvelope['prebuilt']> {
  return {
    package: result.package,
    version: result.version,
    gitSha: result.gitSha,
    artifact_sha256: result.artifactSha256,
  };
}
export async function assertPrebuiltConfiguration(
  project: string,
  configPath?: string,
): Promise<void> {
  if (configPath !== undefined || (await stat(resolvePath(project, 'broker.config.ts')))) {
    const error = new CloudflareError('invalid_input', 2, false, 'prebuilt');
    error.message = 'custom configuration needs a build: run pb build or omit --prebuilt';
    throw error;
  }
}
async function checkOutput(project: string, out: string, source: string) {
  const rel = relative(project, out);
  if (
    !rel ||
    isAbsolute(rel) ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    rel.split(sep).includes('.git') ||
    rel === `.pb${sep}state` ||
    rel.startsWith(`.pb${sep}state${sep}`) ||
    !relative(out, source).startsWith(`..${sep}`) ||
    !relative(source, out).startsWith(`..${sep}`)
  )
    return unsafe();
  let current = project;
  for (const part of rel.split(sep)) {
    current = resolvePath(current, part);
    const entry = await stat(current);
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) return unsafe();
  }
}

async function canonical(path: string): Promise<string> {
  const entry = await stat(path);
  if (entry) return realpath(path);
  return resolvePath(await canonical(dirname(path)), basename(path));
}
async function locked(out: string): Promise<boolean> {
  const path = `${out}.lock`;
  try {
    const entry = await stat(path);
    if (!entry) return false;
    if (!entry.isFile() || entry.isSymbolicLink()) return true;
    const pid: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}
export async function removePrebuilt(out: string): Promise<void> {
  await rm(out, { recursive: true, force: true });
  await rm(`${out}.lock`, { force: true });
}
async function sweep(selectedOut: string, source: string): Promise<void> {
  const parent = dirname(selectedOut);
  const prefix = basename(selectedOut);
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  const run = new RegExp(`^${uuid}$`);
  const temporary = new RegExp(`^${uuid}\\.tmp-[A-Za-z0-9]{6}$`);
  const lock = new RegExp(`^${uuid}\\.lock$`);
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    try {
      if (!entry.name.startsWith(`${prefix}.`)) continue;
      const suffix = entry.name.slice(prefix.length + 1);
      const path = resolvePath(parent, entry.name);
      if (
        !relative(path, source).startsWith(`..${sep}`) ||
        !relative(source, path).startsWith(`..${sep}`)
      )
        continue;
      if (entry.isFile() && lock.test(suffix)) {
        const owner = path.slice(0, -'.lock'.length);
        if (!(await locked(owner)) && !(await stat(owner))) await rm(path, { force: true });
        continue;
      }
      if (!entry.isDirectory()) continue;
      const isTemporary = temporary.test(suffix);
      if (!isTemporary && !run.test(suffix)) continue;
      const owner = isTemporary ? path.slice(0, path.lastIndexOf('.tmp-')) : path;
      if (await locked(owner)) continue;
      if (!isTemporary) {
        const marker = object(JSON.parse((await regular(path, 'prebuilt.json')).toString('utf8')));
        if (marker.package !== PACKAGE) continue;
      }
      await rm(path, { recursive: true, force: true });
      await rm(`${owner}.lock`, { force: true });
    } catch {
      continue;
    }
  }
}
export async function materializePrebuilt(
  o: MaterializePrebuiltOptions,
): Promise<PrebuiltMaterialization> {
  try {
    const project = await realpath(resolvePath(o.project));
    const requestedOut = resolvePath(o.project, o.outDir ?? '.pb/prebuilt/cloudflare');
    if ((await stat(requestedOut))?.isSymbolicLink()) return unsafe();
    const selectedOut = await canonical(requestedOut);
    const outDir = `${selectedOut}.${randomUUID()}`;
    let expected = o.expected;
    if (expected === undefined) {
      try {
        expected = JSON.parse(
          await readFile(new URL('./prebuilt-expected.json', import.meta.url), 'utf8'),
        ) as PrebuiltExpected;
      } catch {
        throw new CloudflareError('prebuilt_unverifiable', 2, false, 'prebuilt');
      }
    }
    const e = object(expected);
    keys(e, ['schemaVersion', 'package', 'version', 'artifactSha256', 'prebuiltJsonSha256']);
    if (
      e.schemaVersion !== 1 ||
      e.package !== PACKAGE ||
      typeof e.version !== 'string' ||
      !digest(e.artifactSha256) ||
      !digest(e.prebuiltJsonSha256)
    )
      invalid();
    const cliVersion =
      o.cliVersion ??
      object(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')))
        .version;
    let packagePath: string;
    try {
      packagePath = (o.resolve ?? createRequire(import.meta.url).resolve)(
        `${PACKAGE}/package.json`,
      );
    } catch {
      throw new CloudflareError('prebuilt_unavailable', 2, false, 'prebuilt');
    }
    let root: string, bytes: Buffer;
    try {
      root = await realpath(dirname(packagePath));
      const entry = await stat(resolvePath(root, 'prebuilt.json'));
      if (!entry) throw new CloudflareError('prebuilt_unavailable', 2, false, 'prebuilt');
      if (!entry.isFile() || entry.isSymbolicLink()) return unsafe();
      bytes = await readFile(resolvePath(root, 'prebuilt.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new CloudflareError('prebuilt_unavailable', 2, false, 'prebuilt');
      throw error;
    }
    const pkg = object(JSON.parse((await regular(root, 'package.json')).toString('utf8')));
    if (pkg.version !== cliVersion || e.version !== cliVersion)
      throw new CloudflareError('prebuilt_version_mismatch', 2, false, 'prebuilt');
    if (hash(bytes) !== e.prebuiltJsonSha256) return mismatch();
    const r = record(JSON.parse(bytes.toString('utf8')));
    if (pkg.name !== PACKAGE) invalid();
    if (
      [
        'dependencies',
        'optionalDependencies',
        'peerDependencies',
        'bundleDependencies',
        'bundledDependencies',
      ].some((key) => Object.hasOwn(pkg, key)) ||
      pkg.gypfile === true ||
      (await stat(resolvePath(root, 'binding.gyp'))) !== null ||
      ['install', 'preinstall', 'postinstall', 'prepare'].some((key) =>
        Object.hasOwn(object(pkg.scripts ?? {}), key),
      )
    )
      throw new CloudflareError('prebuilt_dependencies_refused', 2, false, 'prebuilt');
    if (r.version !== cliVersion)
      throw new CloudflareError('prebuilt_version_mismatch', 2, false, 'prebuilt');
    const payload = resolvePath(root, 'cloudflare');
    const payloadStat = await stat(payload);
    if (!payloadStat?.isDirectory() || payloadStat.isSymbolicLink()) return unsafe();
    const listed = new Set(Object.keys(r.files));
    async function inventory(dir: string, prefix = ''): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const name = `${prefix}${entry.name}`;
        pathParts(name);
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) return unsafe();
        if (entry.isDirectory()) await inventory(resolvePath(dir, entry.name), `${name}/`);
        else if (!listed.has(name)) return mismatch();
      }
    }
    await inventory(payload);
    const files = new Map<string, Buffer>();
    for (const name of listed) {
      const content = await regular(payload, name);
      files.set(name, content);
    }
    await checkOutput(project, selectedOut, root);
    await mkdir(dirname(outDir), { recursive: true });
    await sweep(selectedOut, root);
    // Reserve the run before creating any payload directory; the command keeps this lock.
    await writeFile(`${outDir}.lock`, JSON.stringify(process.pid), { flag: 'wx' });
    let temporary: string | undefined;
    let published = false;
    try {
      temporary = await mkdtemp(`${outDir}.tmp-`);
      const tree = resolvePath(temporary, 'tree');
      await mkdir(tree);
      for (const [name, content] of files) {
        const destination = resolvePath(tree, name);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content, { flag: 'wx' });
        if (`sha256:${hash(await readFile(destination))}` !== r.files[name]) return mismatch();
      }
      const info = object(JSON.parse(files.get('build-info.json')!.toString('utf8')));
      if (info.dirty !== false) throw new CloudflareError('prebuilt_dirty', 2, false, 'prebuilt');
      if (info.gitSha !== r.gitSha)
        throw new CloudflareError('prebuilt_git_sha_mismatch', 2, false, 'prebuilt');
      if (info.lockfileSha256 !== r.lockfileSha256)
        throw new CloudflareError('prebuilt_lockfile_mismatch', 2, false, 'prebuilt');
      await rm(resolvePath(tree, 'wrangler.toml'), { force: true });
      const artifact = await validateDeploymentArtifact(tree);
      if (artifact.artifactHash !== r.artifactSha256 || artifact.artifactHash !== e.artifactSha256)
        return mismatch();
      await writeFile(resolvePath(tree, 'prebuilt.json'), bytes, { flag: 'wx' });
      await checkOutput(project, outDir, root);
      await rename(tree, outDir);
      published = true;
    } finally {
      try {
        if (temporary) await rm(temporary, { recursive: true, force: true });
      } finally {
        if (!published) await removePrebuilt(outDir);
      }
    }
    return {
      outDir,
      package: PACKAGE,
      version: r.version,
      gitSha: r.gitSha,
      artifactSha256: r.artifactSha256,
    };
  } catch (error) {
    if (error instanceof CloudflareError) {
      if (error.stage === 'prebuilt') throw error;
      return invalid();
    }
    if (error instanceof SyntaxError) return invalid();
    if (/^E[A-Z0-9]+$/.test((error as NodeJS.ErrnoException | null)?.code ?? ''))
      throw new CloudflareError('prebuilt_io_failure', 1, false, 'prebuilt');
    throw error;
  }
}
