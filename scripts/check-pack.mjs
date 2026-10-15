import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_PACKAGES = ['core', 'cli', 'db-sqlite', 'runtime-cloudflare', 'runtime-node', 'ui'];
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const UNRESOLVED_RANGE = /^(?:workspace|catalog|link|file):/;
const TEST_FILE = /\.(?:test|spec|test-d)\.|(?:^|\/)__tests__\//;
const ENTRY_FIELDS = ['main', 'types', 'typings', 'module'];
const REQUIRED_FILES = {
  'db-sqlite': ['migrations/0001_init.sql', 'migrations/0002_local_login.sql'],
};
const FORBIDDEN_EXPORTS = { 'db-sqlite': ['./sql/inline'] };

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

  for (const required of REQUIRED_FILES[pkg] ?? []) {
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
    return checkPackedPackage(pkg, pkgJson, files);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const { names: packages, rejected } = planPackages();

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

  if (result.problems.length > 0) {
    process.exitCode = 1;
    console.error(`${pkg}: FAILED (${result.problems.length} problem(s))`);
    for (const problem of result.problems) console.error(`  ${problem}`);
  } else {
    console.log(
      `${pkg}: ok (${result.files} packed files, ${result.targets} entry targets resolved)`,
    );
  }
}
