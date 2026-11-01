import { appendFileSync, existsSync, globSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const checks = ['clientMatrix', 'uiBrowser', 'smokeCloudflare', 'smokeNode', 'treeshake', 'pack'];
const bundles = ['smokeCloudflare', 'smokeNode', 'treeshake', 'pack'];

// Path table: runtime wiring imports more than the workspace dependency graph records.
export const pathRules = [
  {
    pattern: /^fixtures\/observability-base\.config\.ts$/,
    checks: ['smokeNode', 'smokeCloudflare'],
    reason: 'Both smokes build the trusted traceparent fixture, which inherits observability-base.',
  },
  {
    pattern:
      /^packages\/(core|db-[^/]+|runtime-node|runtime-cloudflare|cli|ui-assets|plugin-[^/]+)\/|^broker\.config\.ts$/,
    checks: ['uiBrowser'],
    reason:
      'Browser fixtures import core UI routes and database/Worker helpers; e2e fixtures build and launch the configured broker bundles.',
  },
  {
    pattern: /^packages\/cli\//,
    checks: ['clientMatrix'],
    reason: 'client-matrix-runtime.mjs invokes the CLI to build its runtime bundles.',
  },
  {
    pattern: /^scripts\/held-batch-smoke\.mjs$/,
    checks: ['smokeNode', 'smokeCloudflare'],
    reason: 'Both smoke harnesses execute the shared held-batch assertions.',
  },
  {
    pattern:
      /^packages\/runtime-cloudflare\/(scripts\/(traceparent-smoke|ui-bundle-regression)\.mjs|src\/db\/d1-executor\.ts)$/,
    checks: ['smokeNode'],
    reason:
      'Node smoke imports the shared Worker assertion helpers; held-batch smoke imports the D1 executor.',
  },
  {
    pattern: /^packages\/core\//,
    checks: ['clientMatrix', ...bundles],
    reason:
      'Registry routes, kernel routing, authentication, authorization and their shared helpers serve every real client.',
  },
  {
    pattern: /^packages\/db-[^/]+\//,
    checks: ['clientMatrix', ...bundles],
    reason: 'Registry persistence and matrix bootstrap use the database packages in both runtimes.',
  },
  {
    pattern: /^packages\/runtime-node\//,
    checks: ['clientMatrix', 'smokeNode', 'treeshake', 'pack'],
    reason: 'Node entry, adapters and smoke are real-client and bundle inputs.',
  },
  {
    pattern: /^packages\/runtime-cloudflare\//,
    checks: ['clientMatrix', 'smokeCloudflare', 'treeshake', 'pack'],
    reason: 'Worker entry, adapters and smoke are real-client and bundle inputs.',
  },
  {
    pattern: /^scripts\/client-matrix[^/]*$/,
    checks: ['clientMatrix'],
    reason: 'Matrix runner, runtime harness and harness tests define the real-client check.',
  },
  {
    pattern: /^fixtures\/(client-matrix|observability-base)\.config\.ts$/,
    checks: ['clientMatrix'],
    reason:
      'Matrix config inherits observability-base; client package fixtures are generated in client-matrix.mjs.',
  },
  {
    pattern: /^packages\/(ui|e2e)\//,
    checks: ['uiBrowser'],
    reason: 'UI assets, browser fixtures and end-to-end harness define browser behavior.',
  },
  {
    pattern: /^packages\/(cli|ui|ui-assets|plugin-[^/]+)\//,
    checks: bundles,
    reason:
      'CLI composition, UI asset provider and compiled plugins are broker.config.ts bundle inputs.',
  },
  {
    pattern: /^(broker\.config\.ts|fixtures\/minimal\.config\.ts)$/,
    checks: bundles,
    reason: 'Default and minimal configurations compose the bundles and tree-shaking variants.',
  },
  {
    pattern: /^scripts\/node-bundle-smoke\.mjs$/,
    checks: ['smokeNode'],
    reason: 'Node HTTP smoke harness.',
  },
  {
    pattern: /^scripts\/check-treeshake\.mjs$/,
    checks: ['treeshake'],
    reason: 'Bundle exclusion assertions and their harness.',
  },
  {
    pattern: /^scripts\/check-pack\.mjs$|^packages\/prebuilt(?:-cloudflare)?\//,
    checks: ['pack'],
    reason: 'Pack assertions and distribution metadata define the published payload.',
  },
];

const shared =
  /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|tsconfig[^/]*\.json|vitest\.config\.ts|eslint\.config\.js|\.prettierrc\.json|\.nvmrc|scripts\/ci-scope\.mjs)$|^\.github\/workflows\//;

export function selectScope(paths, graph, { headBranch = '', forceFull = false } = {}) {
  const output = {
    packages: [],
    ...Object.fromEntries(checks.map((key) => [key, false])),
    full: forceFull || headBranch.startsWith('release-please--'),
  };
  const selected = new Set();
  for (const path of paths) {
    if (shared.test(path)) output.full = true;
    const pkg = graph.find((entry) => path.startsWith(`${entry.path}/`));
    if (pkg) selected.add(pkg.name);
    if (path.startsWith('docs/') || (!path.startsWith('packages/') && path.endsWith('.md')))
      continue;
    let matched = false;
    for (const rule of pathRules) {
      if (!rule.pattern.test(path)) continue;
      matched = true;
      for (const key of rule.checks) output[key] = true;
    }
    if (!pkg && !matched) output.full = true;
    if (path.startsWith('packages/') && !pkg) output.full = true;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const pkg of graph) {
      if (!selected.has(pkg.name) && pkg.dependencies.some((name) => selected.has(name))) {
        selected.add(pkg.name);
        changed = true;
      }
    }
  }
  output.packages = graph
    .filter((pkg) => output.full || selected.has(pkg.name))
    .map((pkg) => pkg.path.split('/').at(-1))
    .sort();
  if (output.full) for (const key of checks) output[key] = true;
  return output;
}

export function readWorkspace(root = '.') {
  const yaml = readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8');
  const section = yaml.match(/^packages:\s*\n((?:[ \t]+[^\n]*\n|\n)+)/m)?.[1];
  if (!section) throw new Error('Unsupported workspace package configuration');
  const patterns = section
    .split('\n')
    .map((line) => line.match(/^\s+-\s+['"]?([^'"\s]+)['"]?\s*$/)?.[1])
    .filter(Boolean);
  if (!patterns.length) throw new Error('Missing workspace package patterns');
  const excludes = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => pattern.slice(1));
  const manifests = new Set(
    patterns
      .filter((pattern) => !pattern.startsWith('!'))
      .flatMap((pattern) => globSync(`${pattern}/package.json`, { cwd: root, exclude: excludes })),
  );
  return [...manifests].sort().map((file) => {
    const manifest = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
    return {
      name: manifest.name,
      path: file.slice(0, -'/package.json'.length),
      dependencies: [
        ...new Set(
          ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
            .flatMap((key) => Object.keys(manifest[key] ?? {}))
            .filter((name) => name.startsWith('@package-broker/')),
        ),
      ],
    };
  });
}

export function commitGate(needs, { eventName = '' } = {}) {
  if (needs.scope?.result !== 'success') return false;
  const scope = needs.scope.outputs;
  const packages = JSON.parse(scope.packages);
  const required = {
    scope: true,
    install: true,
    lint: true,
    dco: eventName === 'pull_request',
    'pr-meta': eventName === 'pull_request',
    typecheck: packages.length > 0,
    unit: packages.length > 0,
    build: scope.smokeNode === 'true' || scope.smokeCloudflare === 'true',
    'ui-e2e': scope.uiBrowser === 'true',
    treeshake: scope.treeshake === 'true' || scope.pack === 'true',
    'client-matrix': scope.clientMatrix === 'true',
  };
  return (
    Object.entries(required).every(
      ([name, selected]) =>
        needs[name]?.result === 'success' || (!selected && needs[name]?.result === 'skipped'),
    ) && Object.values(needs).every(({ result }) => result === 'success' || result === 'skipped')
  );
}

export function runCheck(check, packages, { spawn = spawnSync, extraArgs = [] } = {}) {
  const run = (args) => {
    const child = spawn('pnpm', args, { stdio: 'inherit' });
    if (child.error || child.status !== 0) throw new Error('Scoped check failed');
  };
  const projects = packages.filter((name) => existsSync(`packages/${name}/tsconfig.json`));
  if (check === 'typecheck' && projects.length) {
    run([
      '--recursive',
      ...projects.flatMap((name) => ['--filter', `@package-broker/${name}`]),
      'exec',
      'tsc',
      '-b',
    ]);
    if (packages.includes('ui'))
      run(['--filter', '@package-broker/ui', 'exec', 'tsc', '-b', 'test-support']);
  } else if (check === 'unit' && projects.length) {
    run(['vitest', 'run', ...projects.flatMap((name) => ['--project', name]), ...extraArgs]);
  } else if (check === 'lint') {
    run(['exec', 'eslint', '.', '--ignore-pattern', 'packages/**']);
    if (packages.length)
      run([
        'exec',
        'eslint',
        '--no-error-on-unmatched-pattern',
        ...packages.map((name) => `packages/${name}`),
      ]);
    run(['exec', 'prettier', '--check', '.']);
  } else if (!['typecheck', 'unit'].includes(check)) {
    throw new Error('Unknown scoped check');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args[0] === '--check') {
    runCheck(args[1], JSON.parse(process.env.PACKAGES), { extraArgs: args.slice(2) });
  } else {
    const input = readFileSync(0, 'utf8');
    const paths = input.split(input.includes('\0') ? '\0' : '\n').filter(Boolean);
    const branchIndex = args.indexOf('--head-branch');
    const result = selectScope(paths, readWorkspace(), {
      headBranch: branchIndex < 0 ? '' : args[branchIndex + 1],
      forceFull: args.includes('--full'),
    });
    console.log(JSON.stringify(result));
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(result)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}\n`)
          .join(''),
      );
  }
}
