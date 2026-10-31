import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { selectScope, readWorkspace, commitGate, runCheck } from './ci-scope.mjs';

const graph = [
  { name: '@package-broker/a', path: 'packages/a', dependencies: [] },
  { name: '@package-broker/b', path: 'packages/b', dependencies: ['@package-broker/a'] },
  { name: '@package-broker/c', path: 'packages/c', dependencies: ['@package-broker/b'] },
  { name: '@package-broker/d', path: 'packages/d', dependencies: [] },
];
const empty = {
  packages: [],
  clientMatrix: false,
  uiBrowser: false,
  smokeCloudflare: false,
  smokeNode: false,
  treeshake: false,
  pack: false,
  full: false,
};
const scope = (paths, options) => selectScope(paths, readWorkspace(), options);

test('changed packages include every transitive dependent, without unrelated packages', () => {
  assert.deepEqual(selectScope(['packages/a/new-file.ts'], graph).packages, ['a', 'b', 'c']);
  assert.deepEqual(selectScope(['packages/b/README.md'], graph).packages, ['b', 'c']);
  assert.deepEqual(
    selectScope(
      ['packages/a/x', 'packages/a/x'],
      [
        ...graph,
        {
          name: '@package-broker/cycle',
          path: 'packages/cycle',
          dependencies: ['@package-broker/cycle', '@package-broker/a'],
        },
      ],
    ).packages,
    ['a', 'b', 'c', 'cycle'],
  );
});

test('documentation outside packages and an empty diff select nothing', () => {
  for (const paths of [[], ['docs/new.md'], ['README.md'], ['design/notes.md']])
    assert.deepEqual(scope(paths), empty);
  assert.deepEqual(scope(['packages/plugin-github/README.md']).packages, ['plugin-github']);
});

for (const path of [
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'vitest.config.ts',
  'eslint.config.js',
  '.prettierrc.json',
  '.nvmrc',
  '.github/workflows/new.yml',
  '.github/workflows/README.md',
  'scripts/ci-scope.mjs',
]) {
  test(`shared input selects everything: ${path}`, () => {
    const result = scope([path]);
    assert.equal(result.packages.length, readWorkspace().length);
    for (const [key, value] of Object.entries(result))
      if (key !== 'packages') assert.equal(value, true, key);
  });
}

const rules = {
  clientMatrix: [
    'packages/core/src/registry/npm/routes.ts',
    'packages/db-sqlite/src/repositories/registry-reads.ts',
    'packages/core/src/auth/token.ts',
    'packages/core/src/authz/policy.ts',
    'packages/core/src/kernel/routes.ts',
    'packages/core/src/secrets/token.ts',
    'packages/core/src/identity/session.ts',
    'packages/runtime-node/src/entry.ts',
    'packages/runtime-cloudflare/src/entry.ts',
    'scripts/client-matrix.test.mjs',
    'fixtures/client-matrix.config.ts',
    'fixtures/observability-base.config.ts',
    'packages/core/test-fixtures/composer-v1/packages.json',
  ],
  uiBrowser: ['packages/ui/src/page.tsx', 'packages/e2e/src/browser/fixtures/x.ts'],
  smokeNode: [
    'packages/runtime-node/src/entry.ts',
    'packages/core/src/ids.ts',
    'packages/db-sqlite/migrations/0001_init.sql',
    'packages/cli/src/build.ts',
    'packages/ui-assets/src/index.ts',
    'packages/plugin-github/src/index.ts',
    'broker.config.ts',
    'fixtures/minimal.config.ts',
    'scripts/node-bundle-smoke.mjs',
  ],
  smokeCloudflare: [
    'packages/runtime-cloudflare/src/entry.ts',
    'packages/core/src/ids.ts',
    'packages/db-sqlite/src/repositories/x.ts',
    'packages/cli/src/build.ts',
    'packages/ui/src/index.ts',
    'packages/plugin-sso-oidc/src/index.ts',
    'broker.config.ts',
    'fixtures/minimal.config.ts',
  ],
  treeshake: [
    'packages/core/src/ids.ts',
    'packages/plugin-github/src/index.ts',
    'fixtures/minimal.config.ts',
    'scripts/check-treeshake.mjs',
  ],
  pack: ['packages/prebuilt/package.json', 'packages/core/src/ids.ts', 'scripts/check-pack.mjs'],
};
for (const [key, paths] of Object.entries(rules))
  for (const path of paths) {
    test(`${key}: ${path}`, () => {
      assert.equal(scope([path])[key], true);
      assert.equal(scope([path]).full, false);
    });
  }

test('package fallback stays local; unknown root and unknown package fail closed', () => {
  assert.deepEqual(scope(['packages/plugin-github/src/new.ts']).packages, ['plugin-github']);
  assert.equal(scope(['packages/plugin-github/src/new.ts']).clientMatrix, false);
  assert.equal(scope(['packages/ui/src/new.ts']).clientMatrix, false);
  assert.equal(scope(['new-input.conf']).full, true);
  assert.equal(scope(['packages/removed/src/index.ts']).full, true);
  assert.equal(scope(['packages/plugin-removed/src/index.ts']).full, true);
  assert.equal(scope(['packages/core-extra/new.ts']).full, true);
  assert.equal(scope(['packages/runtime-node/src/new.ts']).smokeCloudflare, false);
});

test('core reaches all declared dependents and both smokes and clients', () => {
  const result = scope(['packages/core/src/ids.ts']);
  for (const name of [
    'core',
    'db-sqlite',
    'runtime-node',
    'runtime-cloudflare',
    'cli',
    'ui',
    'ui-assets',
    'plugin-github',
    'plugin-sso-oidc',
  ])
    assert.ok(result.packages.includes(name));
  assert.equal(result.clientMatrix, true);
  assert.equal(result.smokeNode, true);
  assert.equal(result.smokeCloudflare, true);
});

test('release manifest PR branch forces full, ordinary PR does not', () => {
  const config = JSON.parse(readFileSync('release-please-config.json'));
  assert.equal(config['separate-pull-requests'], false);
  assert.equal(config['pull-request-title-pattern'], undefined);
  assert.match(
    readFileSync('.github/workflows/release-please.yml', 'utf8'),
    /config-file: release-please-config.json/,
  );
  assert.equal(scope(['README.md'], { headBranch: 'release-please--branches--main' }).full, true);
  assert.equal(scope([], { headBranch: 'release-please--future' }).full, true);
  assert.equal(scope(['README.md'], { headBranch: 'feature/release-please--' }).full, false);
});

test('CLI JSON equals GitHub outputs; release flag and NUL-delimited paths work', () => {
  const dir = mkdtempSync('.ci-scope-test-');
  try {
    const output = join(dir, 'output');
    const run = spawnSync(
      process.execPath,
      ['scripts/ci-scope.mjs', '--head-branch', 'release-please--branches--main'],
      {
        input: 'docs/a b.md\0README.md\0',
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: output },
      },
    );
    assert.equal(run.status, 0, run.stderr);
    const plain = spawnSync(process.execPath, ['scripts/ci-scope.mjs'], {
      input: 'docs/a b.md\0packages/plugin-github/src/a\nb.ts\0',
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '' },
    });
    assert.equal(plain.status, 0, plain.stderr);
    assert.deepEqual(
      JSON.parse(plain.stdout),
      scope(['docs/a b.md', 'packages/plugin-github/src/a\nb.ts']),
    );
    const newline = spawnSync(process.execPath, ['scripts/ci-scope.mjs'], {
      input: 'docs/a.md\nREADME.md\n',
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '' },
    });
    assert.equal(newline.status, 0, newline.stderr);
    assert.deepEqual(JSON.parse(newline.stdout), empty);
    const full = spawnSync(process.execPath, ['scripts/ci-scope.mjs', '--full'], {
      input: '',
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '' },
    });
    assert.equal(full.status, 0, full.stderr);
    assert.equal(JSON.parse(full.stdout).full, true);
    const result = JSON.parse(run.stdout);
    assert.equal(result.full, true);
    assert.deepEqual(
      Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .map((line) => {
            const i = line.indexOf('=');
            return [line.slice(0, i), JSON.parse(line.slice(i + 1))];
          }),
      ),
      result,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commit gate requires selected jobs, tolerates only scope skips and event metadata skips', () => {
  const docs = {
    scope: {
      result: 'success',
      outputs: Object.fromEntries(Object.entries(empty).map(([k, v]) => [k, JSON.stringify(v)])),
    },
    install: { result: 'success' },
    lint: { result: 'success' },
    'pr-meta': { result: 'skipped' },
    dco: { result: 'skipped' },
    typecheck: { result: 'skipped' },
    unit: { result: 'skipped' },
    build: { result: 'skipped' },
    'ui-e2e': { result: 'skipped' },
    treeshake: { result: 'skipped' },
    'client-matrix': { result: 'skipped' },
  };
  assert.equal(commitGate(docs), true);
  assert.equal(commitGate(docs, { eventName: 'pull_request' }), false);
  assert.equal(
    commitGate(
      { ...docs, dco: { result: 'success' }, 'pr-meta': { result: 'success' } },
      { eventName: 'pull_request' },
    ),
    true,
  );
  for (const name of ['dco', 'pr-meta']) {
    const pr = { ...docs, dco: { result: 'success' }, 'pr-meta': { result: 'success' } };
    pr[name] = { result: 'skipped' };
    assert.equal(commitGate(pr, { eventName: 'pull_request' }), false);
  }
  for (const result of ['failure', 'cancelled', 'skipped'])
    assert.equal(commitGate({ ...docs, lint: { result } }), false);
  for (const key of [
    'clientMatrix',
    'uiBrowser',
    'smokeNode',
    'smokeCloudflare',
    'treeshake',
    'pack',
    'packages',
  ]) {
    const selected = structuredClone(docs);
    selected.scope.outputs[key] = key === 'packages' ? '["core"]' : 'true';
    assert.equal(commitGate(selected), false, key);
  }
  assert.equal(commitGate({ ...docs, scope: { result: 'failure' } }), false);
  for (const result of ['failure', 'cancelled']) {
    for (const name of ['ui-e2e', 'pr-meta', 'dco', 'future-job'])
      assert.equal(commitGate({ ...docs, [name]: { result } }), false);
  }
});

test('workflow uses event bases, full checkout, scoped checks and scope-aware gate', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  for (const text of [
    'github.event.pull_request.base.sha',
    'github.event.merge_group.base_sha',
    'github.event.before',
    'fetch-depth: 0',
    'git diff --name-only -z "$BASE_SHA"..."$HEAD_SHA"',
    'github.head_ref',
    "--exclude '**/test-support/**' --exclude '**/*.browser.test.ts'",
    "if: matrix.shard == 1 && needs.scope.outputs.full == 'true'",
    'scripts/ci-scope.test.mjs',
    '--check typecheck',
    '--check lint',
    '--check unit',
    'commitGate(JSON.parse(process.env.NEEDS), { eventName: process.env.EVENT_NAME })',
  ])
    assert.ok(workflow.includes(text), text);
});

test('workspace graph follows dependency, dev, peer and optional edges and workspace patterns', () => {
  const dir = mkdtempSync('.ci-scope-test-');
  try {
    writeFileSync(
      join(dir, 'pnpm-workspace.yaml'),
      "packages:\n  - 'modules/*'\n  - '!modules/excluded'\n",
    );
    for (const [name, field] of [
      ['a', 'dependencies'],
      ['b', 'devDependencies'],
      ['c', 'peerDependencies'],
      ['d', 'optionalDependencies'],
      ['excluded', 'dependencies'],
    ]) {
      mkdirSync(join(dir, 'modules', name), { recursive: true });
      writeFileSync(
        join(dir, 'modules', name, 'package.json'),
        JSON.stringify({
          name: `@package-broker/${name}`,
          [field]: { '@package-broker/base': 'workspace:*', external: '*' },
        }),
      );
    }
    const loaded = readWorkspace(dir);
    assert.equal(loaded.length, 4);
    for (const entry of loaded) assert.deepEqual(entry.dependencies, ['@package-broker/base']);
    assert.deepEqual(selectScope(['modules/a/new.ts'], loaded).packages, ['a']);
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
    assert.throws(() => readWorkspace(dir), /Unsupported workspace/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scoped command construction keeps filters and shard arguments, skips distribution shells', () => {
  const calls = [];
  const spawn = (command, args) => {
    assert.equal(command, 'pnpm');
    calls.push(args);
    return { status: 0 };
  };
  runCheck('unit', ['plugin-github', 'prebuilt'], { spawn, extraArgs: ['--shard=1/2'] });
  assert.deepEqual(calls.pop(), ['vitest', 'run', '--project', 'plugin-github', '--shard=1/2']);
  runCheck('typecheck', ['plugin-github', 'prebuilt'], { spawn });
  assert.deepEqual(calls.pop(), [
    '--recursive',
    '--filter',
    '@package-broker/plugin-github',
    'exec',
    'tsc',
    '-b',
  ]);
  runCheck('typecheck', ['ui'], { spawn });
  assert.deepEqual(calls.pop(), [
    '--filter',
    '@package-broker/ui',
    'exec',
    'tsc',
    '-b',
    'test-support',
  ]);
  calls.length = 0;
  runCheck('unit', ['prebuilt'], { spawn });
  assert.equal(calls.length, 0);
  runCheck('lint', ['plugin-github'], { spawn });
  assert.deepEqual(calls, [
    ['exec', 'eslint', '.', '--ignore-pattern', 'packages/**'],
    ['exec', 'eslint', '--no-error-on-unmatched-pattern', 'packages/plugin-github'],
    ['exec', 'prettier', '--check', '.'],
  ]);
  assert.throws(
    () => runCheck('unit', ['core'], { spawn: () => ({ status: 1 }) }),
    /Scoped check failed/,
  );
});

test('workflow gates every expensive job and preserves metadata checks on pull requests', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const jobs = Object.fromEntries(
    [
      ...workflow.matchAll(/^ {2}([a-z0-9-]+):\n([\s\S]*?)(?=^ {2}[a-z0-9-]+:\n|$(?![\s\S]))/gm),
    ].map((match) => [match[1], match[2]]),
  );
  for (const [job, output] of [
    ['typecheck', 'packages'],
    ['unit', 'packages'],
    ['build', 'smokeCloudflare'],
    ['build', 'smokeNode'],
    ['ui-e2e', 'uiBrowser'],
    ['treeshake', 'treeshake'],
    ['treeshake', 'pack'],
    ['client-matrix', 'clientMatrix'],
  ]) {
    assert.match(jobs[job], new RegExp(`    if: .*needs.scope.outputs.${output}`));
    assert.ok(jobs[job].includes('needs: [scope, install]'));
  }
  assert.ok(!jobs.lint.includes('node --test'));
  assert.ok(jobs.unit.includes('node --test scripts/ci-scope.test.mjs'));
  for (const job of ['dco', 'pr-meta'])
    assert.ok(jobs[job].includes("if: github.event_name == 'pull_request'"));
  assert.ok(jobs['commit-gate'].includes('if: always()'));
});
