import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_PACKAGES = ['core', 'cli', 'db-sqlite', 'runtime-cloudflare', 'runtime-node', 'ui'];
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const UNRESOLVED_RANGE = /^(?:workspace|catalog|link|file):/;
const CORE_PACKAGE = '@package-broker/core';
const CORE_PEER_PACKAGES = new Set(['plugin-github', 'plugin-sso-oidc']);
const TEST_FILE = /\.(?:test|spec|test-d)\.|(?:^|\/)__tests__\//;
const ENTRY_FIELDS = ['main', 'types', 'typings', 'module'];
const STATIC_REQUIRED_FILES = {
  core: [
    'dist/api/openapi.js',
    'dist/api/openapi.d.ts',
    'dist/api/openapi-route.js',
    'dist/api/openapi-route.d.ts',
  ],
  'db-sqlite': ['migrations/0010_job_claim_index.sql'],
};
const MIGRATION_PACKAGES = ['db-sqlite'];
const FORBIDDEN_EXPORTS = { 'db-sqlite': ['./sql/inline'] };

function migrationProblems(pkg, names) {
  const problems = [];
  const numbers = names.map((name) => /^(\d+)_/.exec(name)?.[1]);
  for (const [index, name] of names.entries()) {
    if (numbers[index] === undefined) problems.push(`migration "${name}" has no numeric prefix`);
    else if (Number(numbers[index]) !== index + 1)
      problems.push(
        `migrations of ${pkg} have a numbering gap: expected ${String(index + 1).padStart(4, '0')}, found "${name}"`,
      );
  }
  return problems;
}

function requiredFiles(pkg) {
  const required = [...(STATIC_REQUIRED_FILES[pkg] ?? [])];
  const problems = [];
  if (MIGRATION_PACKAGES.includes(pkg)) {
    const names = readdirSync(join(ROOT, 'packages', pkg, 'migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    required.push(...names.map((name) => `migrations/${name}`));
    problems.push(...migrationProblems(pkg, names));
  }
  return { required, problems };
}

function readPackageJson(name) {
  try {
    const parsed = JSON.parse(readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { error: 'package.json is not a JSON object' };
    return { json: parsed };
  } catch (error) {
    return { error: `package.json is unreadable or invalid: ${error.message}` };
  }
}

const CORE_VERSION = readPackageJson('core').json?.version ?? '0.0.0';

function planPackages() {
  const names = new Set(REQUIRED_PACKAGES);
  const rejected = new Map();
  for (const name of REQUIRED_PACKAGES) {
    const { json, error } = readPackageJson(name);
    if (error) rejected.set(name, error);
    else if (json.private === true)
      rejected.set(name, 'is marked "private": true but must be published');
  }
  const entries = readdirSync(join(ROOT, 'packages'), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || names.has(entry.name)) continue;
    const { json } = readPackageJson(entry.name);
    if (json && json.private !== true) names.add(entry.name);
  }
  return { names: [...names].sort(), rejected };
}

function targetShapeProblem(target) {
  if (!target.startsWith('./')) return 'does not start with "./"';
  const segments = target.split('/');
  if (segments.includes('..')) return 'contains a ".." segment';
  if (segments.includes('node_modules')) return 'points into node_modules';
  return null;
}

function listFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile())
        files.push(
          path
            .slice(root.length + 1)
            .split(sep)
            .join('/'),
        );
    }
  };
  walk(root);
  return files.sort();
}

function collectTargets(value, targets = []) {
  if (typeof value === 'string') targets.push(value);
  else if (Array.isArray(value)) for (const item of value) collectTargets(item, targets);
  else if (value && typeof value === 'object')
    for (const item of Object.values(value)) collectTargets(item, targets);
  return targets;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wildcardValues(target, files) {
  const [head, ...rest] = target.split('*');
  const pattern = new RegExp(
    `^${escapeRegExp(head)}(.*)${rest.map((part) => escapeRegExp(part)).join('\\1')}$`,
  );
  const values = new Set();
  for (const file of files) {
    const match = pattern.exec(`./${file}`);
    if (match) values.add(match[1]);
  }
  return values;
}

function normalizeExports(exportsField) {
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) return { '.': exportsField };
  if (exportsField && typeof exportsField === 'object') {
    const keys = Object.keys(exportsField);
    if (keys.length > 0 && keys.every((key) => !key.startsWith('.'))) return { '.': exportsField };
    return exportsField;
  }
  return null;
}

function checkExports(pkg, pkgJson, files) {
  const problems = [];
  const targets = [];
  if (pkgJson.exports === undefined) {
    problems.push('packed package.json has no "exports" field');
    return { problems, targets };
  }
  const exportsField = normalizeExports(pkgJson.exports);
  if (exportsField === null) {
    problems.push('"exports" has an unsupported shape, the check cannot walk it');
    return { problems, targets };
  }

  const forbidden = FORBIDDEN_EXPORTS[pkg] ?? [];
  if (pkg === 'core') {
    const api = exportsField['./api/*'];
    if (api?.types !== './dist/api/*.d.ts' || api?.default !== './dist/api/*.js')
      problems.push(
        'export "./api/*" must map types and default to dist/api/*.d.ts and dist/api/*.js',
      );
  }
  for (const key of forbidden) {
    if (Object.hasOwn(exportsField, key))
      problems.push(`export "${key}" is advertised but must be gone`);
  }

  const present = new Set(files);
  for (const [key, value] of Object.entries(exportsField)) {
    if (value === null) continue;
    const keyTargets = collectTargets(value);
    if (keyTargets.length === 0) problems.push(`export "${key}" has no string target to resolve`);
    targets.push(...keyTargets);

    const wildcards = [];
    for (const target of keyTargets) {
      const shape = targetShapeProblem(target);
      if (shape) {
        problems.push(`export "${key}": target "${target}" ${shape}`);
        continue;
      }
      if (target.includes('*')) {
        const values = wildcardValues(target, files);
        if (values.size === 0)
          problems.push(
            `export "${key}": target "${target}" matches no file in the tarball (${files.length} files packed)`,
          );
        else wildcards.push({ target, values });
      } else if (!present.has(target.replace(/^\.\//, ''))) {
        problems.push(`export "${key}": target "${target}" is missing from the tarball`);
      }
    }

    if (key.includes('*')) {
      const resolved = new Set(wildcards.flatMap(({ values }) => [...values]));
      for (const value of resolved) {
        const subpath = key.split('*').join(value);
        if (forbidden.includes(subpath))
          problems.push(
            `export "${key}" resolves "${subpath}" through a wildcard but it must be gone`,
          );
      }
    }

    for (const { target, values } of wildcards.slice(1)) {
      const reference = wildcards[0];
      const missing = [...reference.values].filter((item) => !values.has(item));
      const extra = [...values].filter((item) => !reference.values.has(item));
      if (missing.length > 0 || extra.length > 0)
        problems.push(
          `export "${key}": "${reference.target}" and "${target}" do not cover the same files (only in "${reference.target}": ${missing.join(', ') || 'none'}; only in "${target}": ${extra.join(', ') || 'none'})`,
        );
    }
  }
  return { problems, targets };
}

function checkEntryFields(pkgJson, files) {
  const problems = [];
  const present = new Set(files);
  const entries = ENTRY_FIELDS.map((field) => [field, pkgJson[field]]);
  if (typeof pkgJson.bin === 'string') entries.push(['bin', pkgJson.bin]);
  else if (pkgJson.bin && typeof pkgJson.bin === 'object')
    for (const [name, value] of Object.entries(pkgJson.bin)) entries.push([`bin.${name}`, value]);

  for (const [field, value] of entries) {
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      problems.push(`"${field}" is not a string`);
      continue;
    }
    const normalized = value.startsWith('./') ? value : `./${value}`;
    const segments = normalized.split('/');
    if (segments.includes('..') || segments.includes('node_modules')) {
      problems.push(`"${field}" target "${value}" escapes the package`);
    } else if (!present.has(normalized.slice(2))) {
      problems.push(`"${field}" target "${value}" is missing from the tarball`);
    }
  }
  return { problems, count: entries.filter(([, value]) => value !== undefined).length };
}

function checkCorePackageContext(dir, pkgJson, files) {
  const entries = [];
  for (const [key, value] of Object.entries(normalizeExports(pkgJson.exports) ?? {})) {
    for (const target of collectTargets(value)) {
      const values = target.includes('*') ? wildcardValues(target, files) : [''];
      for (const match of values) {
        const file = target.split('*').join(match);
        if (/\.(?:[cm]?js|[cm]?ts)$/.test(file))
          entries.push({ subpath: key.split('*').join(match), file: join(dir, file) });
      }
    }
  }

  const program = ts.createProgram([...new Set(entries.map(({ file }) => file))], {
    allowJs: true,
    noEmit: true,
    noLib: true,
    types: [],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const checker = program.getTypeChecker();
  const forbidden = new Set([
    'setResolvedPackage',
    'packageActorOf',
    'setPackageActor',
    'clearPackageActor',
  ]);
  const problems = new Set();
  const inspectSymbol = (symbol, subpath, visited = new Set()) => {
    const original =
      symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    if (visited.has(original)) return;
    visited.add(original);
    if (forbidden.has(symbol.name) || forbidden.has(original.name))
      problems.add(`core export "${subpath}" exposes kernel-only "${original.name}"`);
    if (original.flags & ts.SymbolFlags.Module)
      for (const member of checker.getExportsOfModule(original))
        inspectSymbol(member, subpath, visited);
  };
  let readers = 0;
  for (const { subpath, file } of entries) {
    const source = program.getSourceFile(file);
    const module = source && checker.getSymbolAtLocation(source);
    if (!module) {
      problems.add(`core export "${subpath}" could not be inspected for private package context`);
      continue;
    }
    const symbols = checker.getExportsOfModule(module);
    for (const symbol of symbols) inspectSymbol(symbol, subpath);
    if (subpath === './kernel/package-context') {
      readers += 1;
      if (!symbols.some((symbol) => symbol.name === 'resolvedPackageOf'))
        problems.add(`core export "${subpath}" must expose resolvedPackageOf`);
    }
  }
  if (readers === 0)
    problems.add('core must export ./kernel/package-context with resolvedPackageOf');
  return [...problems];
}

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function comparePrerelease(left, right) {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  const a = left.split('.');
  const b = right.split('.');
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const one = a[index];
    const two = b[index];
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    const oneNumeric = /^\d+$/.test(one);
    const twoNumeric = /^\d+$/.test(two);
    if (oneNumeric && twoNumeric) {
      if (Number(one) !== Number(two)) return Number(one) < Number(two) ? -1 : 1;
    } else if (oneNumeric !== twoNumeric) {
      return oneNumeric ? -1 : 1;
    } else if (one !== two) {
      return one < two ? -1 : 1;
    }
  }
  return 0;
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch'])
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

function rangeSatisfiedBy(range, versionText) {
  const version = parseVersion(versionText);
  if (!version) return null;
  const text = range.trim();
  if (text === '*' || text === '' || text === 'x') return version.prerelease === null;
  const caret = /^\^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  const exact = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  const match = caret ?? exact;
  if (!match) return null;
  const lower = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
  if (compareVersions(version, lower) < 0) return false;
  if (!caret) return compareVersions(version, lower) === 0;
  let upper;
  if (lower.major > 0) upper = { major: lower.major + 1, minor: 0, patch: 0, prerelease: null };
  else if (lower.minor > 0)
    upper = { major: 0, minor: lower.minor + 1, patch: 0, prerelease: null };
  else upper = { major: 0, minor: 0, patch: lower.patch + 1, prerelease: null };
  if (compareVersions(version, upper) >= 0) return false;
  if (version.prerelease !== null) {
    if (lower.prerelease === null) return false;
    if (
      version.major !== lower.major ||
      version.minor !== lower.minor ||
      version.patch !== lower.patch
    )
      return false;
  }
  return true;
}

function checkCorePeer(pkg, pkgJson, coreVersion) {
  if (!CORE_PEER_PACKAGES.has(pkg)) return [];
  const range = pkgJson.peerDependencies?.[CORE_PACKAGE];
  if (typeof range !== 'string')
    return [`peerDependencies.${CORE_PACKAGE} is missing or not a string`];
  const satisfied = rangeSatisfiedBy(range, coreVersion);
  if (satisfied === null)
    return [
      `peerDependencies.${CORE_PACKAGE} range "${range}" is not a form this check can verify against core ${coreVersion}`,
    ];
  if (!satisfied)
    return [
      `peerDependencies.${CORE_PACKAGE} range "${range}" does not accept core ${coreVersion}`,
    ];
  return [];
}

function checkPackedPackage(pkg, pkgJson, files) {
  const { problems, targets } = checkExports(pkg, pkgJson, files);
  const entry = checkEntryFields(pkgJson, files);
  problems.push(...entry.problems);

  const shippedTests = files.filter((file) => TEST_FILE.test(file));
  if (shippedTests.length > 0) problems.push(`test files are shipped: ${shippedTests.join(', ')}`);

  for (const field of DEPENDENCY_FIELDS) {
    const entries = pkgJson[field];
    if (!entries || typeof entries !== 'object') continue;
    for (const [name, range] of Object.entries(entries)) {
      if (typeof range === 'string' && UNRESOLVED_RANGE.test(range))
        problems.push(`${field}.${name} is still "${range}" in the packed package.json`);
    }
  }

  const expected = requiredFiles(pkg);
  problems.push(...expected.problems);
  for (const required of expected.required) {
    if (!files.includes(required)) problems.push(`"${required}" is missing from the tarball`);
  }

  return { problems, targets: targets.length + entry.count, files: files.length };
}

function inspect(pkg) {
  const tmp = mkdtempSync(join(tmpdir(), `pb-check-pack-${pkg}-`));
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', tmp], {
      cwd: join(ROOT, 'packages', pkg),
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const tarballs = readdirSync(tmp).filter((name) => name.endsWith('.tgz'));
    if (tarballs.length !== 1)
      throw new Error(
        `expected exactly one tarball, found ${tarballs.length}: ${tarballs.join(', ')}`,
      );
    const extract = join(tmp, 'extract');
    mkdirSync(extract);
    execFileSync('tar', ['-xzf', join(tmp, tarballs[0]), '-C', extract], { stdio: 'inherit' });
    const dir = join(extract, 'package');
    const files = listFiles(dir);
    const pkgJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const result = checkPackedPackage(pkg, pkgJson, files);
    if (pkg === 'core') result.problems.push(...checkCorePackageContext(dir, pkgJson, files));
    return { ...result, pkgJson };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const { names: packages, rejected } = planPackages();

const outcomes = [];
for (const pkg of packages) {
  let result;
  try {
    if (rejected.has(pkg)) throw new Error(rejected.get(pkg));
    result = inspect(pkg);
  } catch (error) {
    result = {
      problems: [
        rejected.has(pkg)
          ? error.message
          : `packing or reading the tarball failed: ${error.message}`,
      ],
      targets: 0,
      files: 0,
    };
  }
  outcomes.push({ pkg, result });
}

const packedCoreVersion =
  outcomes.find(({ pkg }) => pkg === 'core')?.result.pkgJson?.version ?? CORE_VERSION;
for (const { pkg, result } of outcomes)
  if (result.pkgJson)
    result.problems.push(...checkCorePeer(pkg, result.pkgJson, packedCoreVersion));

const coreOutcome = outcomes.find(({ pkg }) => pkg === 'core');
if (coreOutcome && coreOutcome.result.problems.length === 0) {
  try {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { generateOpenApi } from '@package-broker/core/api/openapi';
         import { openApiRoute } from '@package-broker/core/api/openapi-route';
         const document = generateOpenApi([], { title: 'Package Broker', version: '2.0.0' });
         console.log(JSON.stringify({ version: document.openapi, path: openApiRoute(document).path }));`,
      ],
      { cwd: join(ROOT, 'packages', 'cli'), encoding: 'utf8' },
    );
    const resolved = JSON.parse(output);
    if (resolved.version !== '3.1.0' || resolved.path !== '/_pb/openapi.json')
      coreOutcome.result.problems.push(
        `./api/* imported from the cli package returned ${output.trim()}`,
      );
  } catch (error) {
    coreOutcome.result.problems.push(
      `./api/* is not importable from the cli package: ${error.message}`,
    );
  }
}

for (const { pkg, result } of outcomes) {
  if (result.problems.length > 0) {
    process.exitCode = 1;
    console.error(`${pkg}: FAILED (${result.problems.length} problem(s))`);
    for (const problem of result.problems) console.error(`  ${problem}`);
  } else {
    console.log(
      `${pkg}: ok (${result.files} packed files, ${result.targets} entry targets resolved)`,
    );
    if (pkg === 'core')
      console.log('  ./api/*: ./api/openapi, ./api/openapi-route (types and default resolved)');
  }
}
