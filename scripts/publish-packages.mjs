import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const PUBLISH_ORDER = [
  'core',
  'db-sqlite',
  'plugin-github',
  'plugin-sso-oidc',
  'ui',
  'ui-assets',
  'runtime-cloudflare',
  'runtime-node',
  'prebuilt',
  'prebuilt-cloudflare',
  'cli',
].map((name) => `packages/${name}`);

export function releasedPaths(text, config) {
  const paths = JSON.parse(text);
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.some((path) => !PUBLISH_ORDER.includes(path) || !config.packages[path]?.component) ||
    new Set(paths).size !== paths.length
  )
    throw new Error('PATHS_RELEASED must be a nonempty array of unique configured package paths');
  return paths;
}

export function orderedPaths(paths) {
  return PUBLISH_ORDER.filter((path) => paths.includes(path));
}

export function componentFor(path, config) {
  const component = config.packages[path]?.component;
  if (!component) throw new Error('Released path has no configured component');
  return component;
}

export function requireHeadTag(component, version, tags) {
  if (!tags.includes(`${component}-v${version}`)) throw new Error('Release tag is not on HEAD');
}

export function requireLockstep(paths) {
  if (
    paths.includes('packages/cli') &&
    !['packages/prebuilt', 'packages/prebuilt-cloudflare'].every((path) => paths.includes(path))
  )
    throw new Error('CLI release requires both prebuilt packages');
}

export const distTag = (version) => (version.includes('-') ? 'rc' : 'latest');

export function requireRepository(pkg, path) {
  if (
    pkg.repository?.url !== 'git+https://github.com/package-broker/broker.git' ||
    pkg.repository?.directory !== path
  )
    throw new Error('Packed repository must match the release repository and directory');
}

export function requireCliExpected(record, version) {
  if (!record || record.version !== version)
    throw new Error('Missing or mismatched CLI expected record');
}

export function existingVersion(result, version) {
  if (result.status === 0) {
    if (JSON.parse(result.stdout) === version) return true;
    throw new Error('Unexpected registry version response');
  }
  // npm emits structured errors with --json; only a confirmed missing version permits publishing.
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new Error('Registry version lookup failed');
  }
  if (response?.error?.code === 'E404') return false;
  throw new Error('Registry version lookup failed');
}

export async function publishSequence(
  packages,
  { pack, view, publish, skipped, log, dryRun = false },
) {
  for (const pkg of packages) {
    try {
      if (existingVersion(view(pkg), pkg.version)) {
        skipped?.(pkg);
        log(`${pkg.name}: skipped existing`);
      } else {
        const tarball = await pack(pkg);
        publish(pkg, tarball, distTag(pkg.version));
        log(`${pkg.name}: ${dryRun ? 'dry-run' : 'published'}`);
      }
    } catch (error) {
      log(`${pkg.name}: failed`);
      throw error;
    }
  }
}

function command(program, args, cwd = ROOT, visible = false) {
  return spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    stdio: visible ? 'inherit' : ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function checked(program, args, cwd, visible = false) {
  const result = command(program, args, cwd, visible);
  if (result.status !== 0) throw new Error(`${program} ${args[0]} failed (exit ${result.status})`);
  return result.stdout;
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function requireResolvedSpecifiers(pkg) {
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ])
    if (
      Object.values(pkg[field] ?? {}).some((value) => /^(workspace|catalog|link|file):/.test(value))
    )
      throw new Error('Packed package has unresolved workspace, catalog, link or file specifiers');
}

export function requireAnchor(expected, prebuilt) {
  const anchor = JSON.parse(expected);
  const record = JSON.parse(prebuilt);
  if (
    anchor.schemaVersion !== 1 ||
    anchor.prebuiltJsonSha256 !== sha256(prebuilt) ||
    anchor.artifactSha256 !== record.artifactSha256 ||
    anchor.version !== record.version ||
    anchor.package !== record.package
  )
    throw new Error('CLI anchor does not match dist-cloudflare manifest');
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

export async function requireStaged(dir, payload) {
  const { prebuiltProblems, stagingState } = await import('./check-pack.mjs');
  const { listFiles } = await import('./stage-prebuilt.mjs');
  if (!stagingState(dir, payload)) throw new Error('Prebuilt manifest and payload must be staged');
  const files = listFiles(join(dir, payload));
  if (
    prebuiltProblems(
      dir,
      files.map((name) => `${payload}/${name}`),
      payload,
    ).length
  )
    throw new Error('Invalid staged prebuilt package');
  if (!files.includes(payload === 'node' ? 'server.js' : 'worker.js'))
    throw new Error('Staged prebuilt entry is missing');
}

function tarFile(tarball, name) {
  return checked('tar', ['-xOf', tarball, `package/${name}`]);
}

function singleTarball(dir) {
  const files = readdirSync(dir).filter((name) => name.endsWith('.tgz'));
  if (files.length !== 1) throw new Error('Expected one packed tarball');
  return join(dir, files[0]);
}

function validatePacked(pkg, tarball, prebuilt) {
  const packed = JSON.parse(tarFile(tarball, 'package.json'));
  requireRepository(packed, pkg.path);
  requireResolvedSpecifiers(packed);
  if (packed.name !== pkg.name || packed.version !== pkg.version)
    throw new Error('Packed identity does not match release');
  if (pkg.path === 'packages/cli') {
    const expected = tarFile(tarball, 'dist/prebuilt-expected.json');
    requireCliExpected(JSON.parse(expected), pkg.version);
    requireAnchor(expected, prebuilt());
  }
}

export function verifyArtifacts(dir, entries) {
  for (const pkg of entries) {
    if (
      typeof pkg.tarball !== 'string' ||
      basename(pkg.tarball) !== pkg.tarball ||
      !pkg.tarball.endsWith('.tgz') ||
      !/^[a-f0-9]{64}$/.test(pkg.sha256)
    )
      throw new Error('Invalid tarball manifest entry');
    if (sha256(readFileSync(join(dir, pkg.tarball))) !== pkg.sha256)
      throw new Error('Tarball sha256 does not match manifest');
    if (pkg.tag !== distTag(pkg.version))
      throw new Error('Manifest dist-tag does not match version');
  }
}

// Resolve the anchor lazily: an existing CLI needs no tarball validation or registry pack.
export async function publishTarballs(
  entries,
  { view, registryPrebuilt, validate, publish, log, dryRun = false },
) {
  let prebuilt;
  await publishSequence(entries, {
    view,
    publish,
    log,
    dryRun,
    skipped(pkg) {
      if (pkg.path === 'packages/prebuilt-cloudflare') prebuilt = () => registryPrebuilt(pkg);
    },
    pack(pkg) {
      if (pkg.path === 'packages/prebuilt-cloudflare')
        prebuilt = () => Buffer.from(pkg.prebuiltJson, 'base64');
      validate(pkg, () => {
        if (!prebuilt) throw new Error('Missing dist-cloudflare manifest for CLI anchor');
        return prebuilt();
      });
      return pkg.tarball;
    },
  });
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run' && !options.dryRun) options.dryRun = true;
    else if (['--tags-file', '--pack-only', '--from-tarballs'].includes(arg) && !options[arg]) {
      if (!args[i + 1] || args[i + 1].startsWith('--'))
        throw new Error('Missing publish argument value');
      options[arg] = args[++i];
    } else throw new Error('Unknown publish argument');
  }
  const dryRun = options.dryRun === true;
  if (options['--tags-file'] && !dryRun)
    throw new Error('Tag injection requires --dry-run and a tags file');
  if (options['--pack-only'] && options['--from-tarballs'])
    throw new Error('Pack and publish modes are mutually exclusive');
  if (options['--from-tarballs'] && options['--tags-file'])
    throw new Error('Tarball publishing uses the build manifest tags');
  if (!options['--pack-only'] && !options['--from-tarballs'])
    throw new Error('Publishing requires --from-tarballs; use --pack-only to build artifacts');
  if (options['--from-tarballs']) {
    const version = checked('npm', ['--version']).trim();
    const [major, minor, patch] = version.split('.').map(Number);
    if (
      !/^\d+\.\d+\.\d+$/.test(version) ||
      !(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))))
    )
      throw new Error('npm >= 11.5.1 is required');
  }
  const config = readJson(join(ROOT, 'release-please-config.json'));
  const from = options['--from-tarballs'];
  const manifest = from ? readJson(join(resolve(from), 'manifest.json')) : undefined;
  if (manifest?.dryRun && !dryRun) throw new Error('Rehearsal artifacts require --dry-run');
  const paths = releasedPaths(
    from ? JSON.stringify(manifest.packages?.map((pkg) => pkg.path)) : process.env.PATHS_RELEASED,
    config,
  );
  requireLockstep(paths);
  const tags = from
    ? undefined
    : options['--tags-file']
      ? readJson(options['--tags-file'])
      : checked('git', ['tag', '--points-at', 'HEAD']).trim().split('\n');
  const packages = orderedPaths(paths).map((path) => {
    const pkg = readJson(join(ROOT, path, 'package.json'));
    if (tags) requireHeadTag(componentFor(path, config), pkg.version, tags);
    const entry = manifest?.packages.find((item) => item.path === path);
    if (entry && (entry.name !== pkg.name || entry.version !== pkg.version))
      throw new Error('Manifest identity does not match release');
    return {
      ...pkg,
      ...entry,
      path,
      payload: {
        'packages/prebuilt': 'node',
        'packages/prebuilt-cloudflare': 'cloudflare',
      }[path],
    };
  });
  if (from) verifyArtifacts(resolve(from), packages);
  const temporary = mkdtempSync(join(tmpdir(), 'pb-publish-'));
  const destination = options['--pack-only'] ? resolve(options['--pack-only']) : temporary;
  const entries = [];
  try {
    if (options['--pack-only']) mkdirSync(destination, { recursive: true });
    async function pack(
      pkg,
      prebuilt = () => {
        const cloudflare = entries.find((item) => item.path === 'packages/prebuilt-cloudflare');
        if (!cloudflare) throw new Error('Missing packed dist-cloudflare manifest');
        return Buffer.from(cloudflare.prebuiltJson, 'base64');
      },
    ) {
      requireRepository(pkg, pkg.path);
      if (pkg.payload) await requireStaged(join(ROOT, pkg.path), pkg.payload);
      const dir = join(temporary, componentFor(pkg.path, config));
      mkdirSync(dir);
      checked('pnpm', ['pack', '--pack-destination', dir], join(ROOT, pkg.path), true);
      const tarball = singleTarball(dir);
      if (pkg.payload) {
        checked('tar', ['-xzf', tarball, '-C', dir]);
        await requireStaged(join(dir, 'package'), pkg.payload);
      }
      const prebuiltJson =
        pkg.path === 'packages/prebuilt-cloudflare'
          ? Buffer.from(tarFile(tarball, 'prebuilt.json')).toString('base64')
          : undefined;
      const entry = {
        path: pkg.path,
        name: pkg.name,
        version: pkg.version,
        tag: distTag(pkg.version),
        tarball: basename(tarball),
        sha256: sha256(readFileSync(tarball)),
        ...(prebuiltJson ? { prebuiltJson } : {}),
      };
      validatePacked(pkg, tarball, prebuilt);
      entries.push(entry);
      if (options['--pack-only']) {
        writeFileSync(join(destination, entry.tarball), readFileSync(tarball));
        console.log(`${pkg.name}: packed`);
      }
      return tarball;
    }
    function registryPrebuilt(pkg) {
      const dir = mkdtempSync(join(temporary, 'registry-'));
      checked(
        'npm',
        ['pack', `${pkg.name}@${pkg.version}`, '--ignore-scripts', '--pack-destination', dir],
        ROOT,
        true,
      );
      return Buffer.from(tarFile(singleTarball(dir), 'prebuilt.json'));
    }
    const actions = {
      // Offline rehearsals deliberately exercise every package as unpublished.
      view: (pkg) =>
        dryRun
          ? { status: 1, stdout: '{"error":{"code":"E404"}}' }
          : command('npm', [
              'view',
              `${pkg.name}@${pkg.version}`,
              'version',
              '--json',
              '--loglevel=silent',
            ]),
      registryPrebuilt,
      validate(pkg, prebuilt) {
        const tarball = join(resolve(from), pkg.tarball);
        validatePacked(pkg, tarball, prebuilt);
        if (
          pkg.path === 'packages/prebuilt-cloudflare' &&
          tarFile(tarball, 'prebuilt.json') !== Buffer.from(pkg.prebuiltJson, 'base64').toString()
        )
          throw new Error('Manifest prebuilt bytes do not match tarball');
      },
      publish(pkg, tarball, tag) {
        checked(
          'npm',
          [
            'publish',
            join(resolve(from), tarball),
            '--ignore-scripts',
            '--access',
            'public',
            '--provenance',
            '--tag',
            tag,
            ...(dryRun ? ['--dry-run'] : []),
          ],
          ROOT,
          true,
        );
      },
      log: console.log,
      dryRun,
    };
    if (options['--pack-only']) {
      for (const pkg of packages) await pack(pkg);
      writeFileSync(
        join(destination, 'manifest.json'),
        `${JSON.stringify({ dryRun, packages: entries }, null, 2)}\n`,
      );
    } else await publishTarballs(packages, actions);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
