import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = fileURLToPath(new URL('../', import.meta.url));
const activeChildren = new Set();
let interruption;
let composerTimeoutMs = 30 * 60_000;
const scenarios = ['upstream-direct', 'broker-proxy', 'marketplace-direct', 'broker-marketplace'];
export const installArgs = [
  'install',
  '--no-interaction',
  '--no-scripts',
  '--no-plugins',
  '--prefer-dist',
  '--no-progress',
];
export const resolveArgs = [
  'update',
  '--no-install',
  '--no-interaction',
  '--no-scripts',
  '--no-plugins',
];
export const measurements = ['install', 'resolve'];
export const help = `Usage: pnpm bench:install [options]
  --runs N          Repetitions per scenario/cache state (default 5)
  --scenarios a,b   ${scenarios.join(', ')} (default all; Marketplace requires keys)
  --timeout-minutes N  Composer timeout (default 30 minutes)
  --out path        JSON output (default .pb/bench-install/results.json)
  --dry-run         Print scenarios, directories and commands without starting processes
  --help            Print this help

  PB_BENCH_DEBUG=1  Print credential-free broker preparation errors
`;

export function parseOptions(args) {
  const options = {
    runs: 5,
    timeoutMinutes: 30,
    scenarios: [...scenarios],
    out: '.pb/bench-install/results.json',
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (['--runs', '--timeout-minutes', '--scenarios', '--out'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing option value');
      if (arg === '--runs') {
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
          throw new Error('Invalid run count');
        options.runs = Number(value);
      } else if (arg === '--timeout-minutes') {
        if (!Number.isFinite(Number(value)) || Number(value) <= 0 || Number(value) > 35791)
          throw new Error('Invalid timeout minutes');
        options.timeoutMinutes = Number(value);
      } else if (arg === '--out') options.out = value;
      else {
        const selected = value.split(',');
        if (
          selected.some((name) => !scenarios.includes(name)) ||
          new Set(selected).size !== selected.length
        )
          throw new Error('Invalid scenarios');
        options.scenarios = selected;
      }
    } else throw new Error('Unknown option');
  }
  return options;
}

export function plan(options, hasKeys) {
  return measurements.flatMap((measurement) =>
    options.scenarios.map((scenario) => ({
      measurement,
      scenario,
      skipped: scenario.includes('marketplace') && !hasKeys,
      states: scenario.startsWith('broker-') ? ['cold', 'warm-broker', 'warm'] : ['cold', 'warm'],
      argv: measurement === 'install' ? installArgs : resolveArgs,
    })),
  );
}

export function schedule(options, hasKeys) {
  return Array.from({ length: options.runs }, (_, i) =>
    plan(options, hasKeys)
      .filter((entry) => !entry.skipped)
      .map((entry) => ({ ...entry, repetition: i + 1 })),
  ).flat();
}

export function marketplacePackages(lock) {
  return [...(lock.packages ?? []), ...(lock['packages-dev'] ?? [])]
    .filter((pkg) => pkg.dist?.url && new URL(pkg.dist.url).hostname === 'repo.magento.com')
    .map((pkg) => pkg.name);
}

export function assertPhpVersion(version) {
  const parts = version.trim().split('.').map(Number);
  if (
    parts.length < 3 ||
    parts.some((part) => !Number.isFinite(part)) ||
    parts[0] < 8 ||
    (parts[0] === 8 && (parts[1] < 4 || (parts[1] === 4 && parts[2] < 1)))
  )
    throw new Error('PHP >= 8.4.1 is required by the benchmark lockfile');
}

export function statistics(runs) {
  const times = runs
    .filter((run) => run.exitCode === 0)
    .map((run) => run.wallMs)
    .sort((a, b) => a - b);
  if (!times.length) return null;
  const middle = Math.floor(times.length / 2);
  return {
    successful: times.length,
    medianMs: times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2,
    minMs: times[0],
    maxMs: times.at(-1),
  };
}

export function generateProject(project, brokerOrigin) {
  const copy = structuredClone(project);
  copy.config = { ...copy.config, 'allow-plugins': false, 'secure-http': !brokerOrigin };
  if (brokerOrigin)
    copy.repositories = [
      { type: 'composer', url: `${brokerOrigin}/bench` },
      { 'packagist.org': false },
    ];
  else delete copy.repositories;
  return copy;
}

export function generateAuth({ brokerOrigin, token, publicKey, privateKey } = {}) {
  const basic = {};
  if (brokerOrigin && token)
    basic[new URL(brokerOrigin).host] = { username: 'token', password: token };
  if (!brokerOrigin && publicKey && privateKey)
    basic['repo.magento.com'] = { username: publicKey, password: privateKey };
  return { 'http-basic': basic };
}

// Only measured fields enter results; subprocess output and API payloads never do.
export function redactResults(value, secrets = []) {
  const scrub = (input) =>
    secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[redacted]'), input);
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return {
    environment: {
      ...Object.fromEntries(
        ['os', 'cpuModel', 'node', 'php', 'composer'].map((key) => [
          key,
          scrub(String(value.environment[key] ?? 'unavailable')).replace(
            /https?:\/\/\S+|\S+@\S+|(?:\d{1,3}\.){3}\d{1,3}/g,
            '[redacted]',
          ),
        ]),
      ),
      cpuCount: number(value.environment.cpuCount),
      ramBytes: number(value.environment.ramBytes),
      date: /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value.environment.date)
        ? value.environment.date
        : null,
      brokerCommit: /^[a-f0-9]{40,64}$/.test(value.environment.brokerCommit)
        ? value.environment.brokerCommit
        : null,
    },
    runs: value.runs
      .filter(
        (run) =>
          measurements.includes(run.measurement) &&
          scenarios.includes(run.scenario) &&
          ['cold', 'warm-broker', 'warm'].includes(run.state),
      )
      .map((run) => ({
        measurement: run.measurement,
        scenario: run.scenario,
        state: run.state,
        repetition: number(run.repetition),
        wallMs: number(run.wallMs),
        exitCode: number(run.exitCode),
        packageCount: number(run.packageCount),
        timedOut: run.timedOut === true,
      })),
  };
}

export function command(program, args, options = {}) {
  const { timeoutMs = program === 'composer' ? composerTimeoutMs : undefined, ...spawnOptions } =
    options;
  interruption?.throwIfAborted();
  return new Promise((done) => {
    const child = spawn(program, args, {
      cwd: root,
      ...spawnOptions,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.add(child);
    let output = '';
    let timedOut = false;
    let killTimer;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
          }, timeoutMs);
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        if (output.length < 8 * 1024 * 1024) output += chunk;
      });
    child.once('error', () => {});
    child.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      activeChildren.delete(child);
      done({ exitCode: timedOut ? 124 : (code ?? 1), output, timedOut });
    });
  });
}

async function checked(program, args, options) {
  const result = await command(program, args, options);
  if (result.exitCode !== 0)
    throw new Error('Benchmark preparation failed (subprocess output suppressed)');
  return result.output;
}

async function writeJson(path, value, privateFile = false) {
  interruption?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', {
    mode: privateFile ? 0o600 : 0o644,
  });
}

export async function composerEnvironment(directory, auth) {
  const home = join(directory, 'home');
  const cache = join(directory, 'cache');
  await mkdir(cache, { recursive: true });
  await writeJson(join(home, 'auth.json'), auth, true);
  // Do not inherit Composer overrides, credentials, proxies or PHP configuration from the caller.
  const env = Object.fromEntries(
    ['PATH', 'SystemRoot', 'TMPDIR']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  return {
    ...env,
    COMPOSER_HOME: home,
    COMPOSER_CACHE_DIR: cache,
    COMPOSER_VENDOR_DIR: join(directory, 'vendor'),
    COMPOSER_NO_AUDIT: '1',
  };
}

function bootstrapArgs(database, setupFile) {
  return [
    process.execPath,
    join(root, 'packages/cli/dist/bin.js'),
    'admin',
    'bootstrap',
    '--sqlite',
    database,
    '--email',
    'bench@example.test',
    '--token-file',
    setupFile,
  ];
}

export async function startBroker(directory, marketplace, keys) {
  const { base32Decode, totpCode } = await import('../packages/core/dist/auth/totp.js');
  const { reserveLoopbackPort, until } = await import('../packages/e2e/src/local.ts');
  const port = await reserveLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const database = join(directory, 'database.sqlite');
  await mkdir(join(directory, 'blobs'), { recursive: true });
  const env = {
    PATH: process.env.PATH,
    PORT: String(port),
    DEPLOYMENT_ID: 'bench',
    PB_SQLITE_PATH: database,
    PB_BLOB_ROOT: join(directory, 'blobs'),
    PB_ORG_SLUG: 'bench',
    PB_ORG_NAME: 'Benchmark',
    PB_PUBLIC_URL: origin,
    PB_MASTER_KEY: `pbmk_v1_${randomBytes(32).toString('base64url')}`,
  };
  // Bundle staging and bootstrap argv follow startNodeFixture (browser/fixtures.ts).
  const runtime = join(directory, 'runtime');
  await cp(join(root, '.pb/node'), runtime, {
    recursive: true,
    filter: (source) => source !== join(root, '.pb/node/node_modules'),
  });
  const driverManifest = createRequire(join(root, 'packages/runtime-node/package.json')).resolve(
    'better-sqlite3/package.json',
  );
  await mkdir(join(runtime, 'node_modules'), { recursive: true });
  await symlink(dirname(driverManifest), join(runtime, 'node_modules/better-sqlite3'), 'dir');
  interruption?.throwIfAborted();
  const child = spawn(process.execPath, [join(runtime, 'server.js')], {
    cwd: root,
    env,
    stdio: 'ignore',
  });
  activeChildren.add(child);
  child.once('close', () => activeChildren.delete(child));
  let spawnFailed = false;
  child.on('error', () => {
    spawnFailed = true;
  });
  const stop = async () => {
    try {
      if (child.exitCode !== null || child.signalCode !== null || spawnFailed) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    await until(
      async () => {
        interruption?.throwIfAborted();
        if (spawnFailed || child.exitCode !== null) throw new Error('Broker startup failed');
        return fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(1000) }).then(
          (r) => r.ok,
          () => false,
        );
      },
      'benchmark-ready',
      60_000,
    );
    const setupFile = join(directory, 'setup-token');
    // The first setup token has no HTTP issuer; use the same CLI as the e2e fixtures.
    await checked(process.execPath, bootstrapArgs(database, setupFile).slice(1), { env });
    const token = (await readFile(setupFile, 'utf8')).trim();
    let cookie = '';
    let csrf = '';
    const api = async (path, body, expected = 204, method = 'POST') => {
      const response = await fetch(origin + path, {
        method,
        headers: { 'content-type': 'application/json', origin, cookie, 'x-csrf-token': csrf },
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          AbortSignal.timeout(30_000),
          ...(interruption ? [interruption] : []),
        ]),
      });
      if (response.status !== expected)
        throw new Error(`Broker API preparation failed (HTTP ${response.status})`);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) {
        cookie = cookies.map((line) => line.split(';')[0]).join('; ');
        csrf = /(?:^|; )__Host-pb_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
      }
      return expected === 204 ? undefined : response.json();
    };
    const { secret } = await api('/_pb/auth/local/setup/start', { token }, 200);
    const secretBytes = base32Decode(secret);
    const password = randomBytes(24).toString('base64url');
    await api('/_pb/auth/local/setup/finish', {
      token,
      password,
      code: await totpCode(secretBytes, Math.floor(Date.now() / 30_000) - 1),
    });
    await api('/_pb/auth/local/reauth', {
      password,
      code: await totpCode(secretBytes, Math.floor(Date.now() / 30_000)),
    });
    const project = await api('/_pb/projects', { slug: 'bench', name: 'Benchmark' }, 201);
    const addSource = async (name, type, url, config, credential) => {
      const { id } = await api(
        '/_pb/sources',
        { name, ecosystem: 'composer', type, url, config },
        201,
      );
      await api(
        `/_pb/projects/bench/sources/${id}/attachment`,
        { precedence: name === 'marketplace' ? 0 : 100 },
        204,
        'PUT',
      );
      if (type === 'composer_repository')
        for (const pattern of keys.packages)
          await api(`/_pb/sources/${id}/names`, { pattern }, 201);
      if (credential)
        await api(
          `/_pb/sources/${id}/credential`,
          { kind: 'http_basic', material: JSON.stringify(credential) },
          204,
          'PUT',
        );
      if (type === 'composer_repository') {
        await api(`/_pb/sources/${id}/enable`, {});
        await api(`/_pb/sources/${id}/sync`, {}, 202);
      }
    };
    await addSource('packagist', 'packagist_proxy', 'https://repo.packagist.org', {
      githubToken: false,
    });
    if (marketplace)
      await addSource(
        'marketplace',
        'composer_repository',
        'https://repo.magento.com',
        { selection: { packages: keys.packages } },
        { username: keys.publicKey, password: keys.privateKey },
      );
    const issued = await api(
      '/_pb/me/tokens',
      {
        name: 'benchmark-reader',
        scope: 'read',
        readOnly: true,
        projectMode: 'selected',
        projectIds: [project.id],
      },
      201,
    );
    if (marketplace) {
      const name = keys.packages[0];
      if (!name) throw new Error('Marketplace has no registered packages');
      await until(
        async () => {
          interruption?.throwIfAborted();
          try {
            const response = await fetch(`${origin}/bench/p2/${name}.json`, {
              headers: {
                authorization: `Basic ${Buffer.from(`token:${issued.token}`).toString('base64')}`,
              },
              signal: AbortSignal.any([
                AbortSignal.timeout(1000),
                ...(interruption ? [interruption] : []),
              ]),
            });
            return response.ok && (await response.json()).packages?.[name]?.length > 0;
          } catch {
            return false;
          }
        },
        'benchmark-marketplace-metadata',
        180_000,
      );
    }
    return { origin, token: issued.token, masterKey: env.PB_MASTER_KEY, stop };
  } catch (error) {
    if (process.env.PB_BENCH_DEBUG === '1') console.error(error);
    await stop();
    throw new Error('Broker preparation failed (details suppressed)', { cause: error });
  }
}

export function rewriteLockedPackage(pkg, versions, origin) {
  let previous = {};
  for (const entry of versions) {
    const expanded = { ...previous, ...entry };
    for (const [key, value] of Object.entries(entry)) if (value === '__unset') delete expanded[key];
    previous = expanded;
    if (expanded.version !== pkg.version || !expanded.dist) continue;
    const url = new URL(expanded.dist.url, origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.search ||
      !url.pathname.startsWith('/bench/dist/')
    )
      throw new Error('Broker archive routing failed');
    if (pkg.dist?.reference && expanded.dist.reference !== pkg.dist.reference)
      throw new Error('Locked archive reference mismatch');
    const copy = structuredClone(pkg);
    copy.dist = { ...expanded.dist, url: url.href };
    delete copy.source;
    return copy;
  }
  throw new Error('Locked package unavailable from broker');
}

export async function brokerLock(
  lock,
  broker,
  {
    fetchMetadata = fetch,
    now = Date.now,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
    timeoutMs = 180_000,
  } = {},
) {
  const result = structuredClone(lock);
  for (const group of ['packages', 'packages-dev']) {
    result[group] = [];
    for (const pkg of lock[group] ?? []) {
      if (pkg.type === 'metapackage') {
        result[group].push(pkg);
        continue;
      }
      const deadline = now() + timeoutMs;
      let rewritten;
      while (!rewritten) {
        interruption?.throwIfAborted();
        const response = await fetchMetadata(`${broker.origin}/bench/p2/${pkg.name}.json`, {
          headers: {
            authorization: `Basic ${Buffer.from(`token:${broker.token}`).toString('base64')}`,
          },
          signal: AbortSignal.any([
            AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - now()))),
            ...(interruption ? [interruption] : []),
          ]),
        }).catch(() => ({ ok: false }));
        if (response.ok) {
          try {
            const metadata = await response.json();
            rewritten = rewriteLockedPackage(
              pkg,
              metadata.packages?.[pkg.name] ?? [],
              broker.origin,
            );
          } catch {
            /* Ingestion may still be queued. */
          }
        }
        if (!rewritten) {
          if (now() >= deadline) throw new Error('Broker metadata preparation timed out');
          await sleep(Math.min(250, deadline - now()));
        }
      }
      result[group].push(rewritten);
    }
  }
  return result;
}

async function fixture(marketplace, directory, keys) {
  const path = join(root, 'fixtures/bench-install', marketplace ? 'magento' : 'project');
  if (marketplace) {
    const env = await composerEnvironment(
      join(directory, 'fixture-preparation'),
      generateAuth(keys),
    );
    try {
      await readFile(join(path, 'composer.json'));
    } catch {
      await checked(
        'composer',
        [
          'create-project',
          '--no-install',
          '--no-interaction',
          '--no-scripts',
          '--no-plugins',
          '--repository-url=https://repo.magento.com/',
          'magento/project-community-edition',
          path,
        ],
        { env },
      );
    }
    try {
      await readFile(join(path, 'composer.lock'));
    } catch {
      await checked(
        'composer',
        [
          'update',
          '--no-install',
          '--no-interaction',
          '--no-scripts',
          '--no-plugins',
          '--prefer-dist',
          '--no-progress',
        ],
        { cwd: path, env },
      );
    }
  }
  return {
    project: JSON.parse(await readFile(join(path, 'composer.json'), 'utf8')),
    lock: JSON.parse(await readFile(join(path, 'composer.lock'), 'utf8')),
  };
}

async function environment() {
  const version = async (program, args, pattern) => {
    const { output } = await command(program, args);
    return pattern.exec(output)?.[0] ?? 'unavailable';
  };
  return {
    os: `${platform()} ${release()}`,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    ramBytes: totalmem(),
    node: process.version,
    php: await version('php', ['--version'], /PHP [\d.]+/),
    composer: await version('composer', ['--version'], /Composer version [\d.\w-]+/),
    date: new Date().toISOString(),
    brokerCommit: (await command('git', ['rev-parse', 'HEAD'])).output.trim(),
  };
}

function measurementTable(runs) {
  const lines = [
    '| Scenario | Cache | Successful | Median ms | Min ms | Max ms |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
  ];
  for (const scenario of scenarios)
    for (const state of ['cold', 'warm-broker', 'warm']) {
      const group = runs.filter((run) => run.scenario === scenario && run.state === state);
      if (!group.length) continue;
      const stats = statistics(group);
      lines.push(
        `| ${scenario} | ${state} | ${stats?.successful ?? 0}/${group.length} | ${stats?.medianMs.toFixed(1) ?? '—'} | ${stats?.minMs.toFixed(1) ?? '—'} | ${stats?.maxMs.toFixed(1) ?? '—'} |`,
      );
    }
  return lines.join('\n');
}

export function markdown(runs) {
  return measurements
    .map(
      (measurement) =>
        `${measurement}\n\n${measurementTable(runs.filter((run) => run.measurement === measurement))}`,
    )
    .join('\n\n');
}

export async function main(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseOptions(args);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  composerTimeoutMs = options.timeoutMinutes * 60_000;
  if (options.help) {
    console.log(help);
    return;
  }
  const keys = {
    publicKey: process.env.PB_BENCH_MAGENTO_PUBLIC_KEY,
    privateKey: process.env.PB_BENCH_MAGENTO_PRIVATE_KEY,
  };
  const entries = plan(options, Boolean(keys.publicKey && keys.privateKey));
  for (const scenario of new Set(
    entries.filter((entry) => entry.skipped).map((entry) => entry.scenario),
  ))
    console.log(`${scenario}: skipped: no repo.magento.com keys`);
  const base = join(root, '.pb/bench-install');
  if (options.dryRun) {
    const session = join(base, 'session-dry-run');
    console.log(
      JSON.stringify(
        {
          baseDirectory: base,
          session,
          out: resolve(root, options.out),
          timeoutMinutes: options.timeoutMinutes,
          plans: schedule(options, Boolean(keys.publicKey && keys.privateKey)).map((entry) => {
            const directory = join(
              session,
              entry.measurement,
              entry.scenario,
              String(entry.repetition),
            );
            return {
              ...entry,
              directory,
              bootstrapArgv: entry.scenario.startsWith('broker-')
                ? bootstrapArgs(
                    join(directory, 'broker/database.sqlite'),
                    join(directory, 'broker/setup-token'),
                  )
                : undefined,
              commands: entry.states.map((state) => ({
                directory: join(directory, state),
                argv: ['composer', ...entry.argv],
              })),
            };
          }),
          marketplacePreparation: [
            'composer',
            'create-project',
            '--no-install',
            '--no-interaction',
            '--no-scripts',
            '--no-plugins',
            '--repository-url=https://repo.magento.com/',
            'magento/project-community-edition',
            join(root, 'fixtures/bench-install/magento'),
          ],
        },
        null,
        2,
      ),
    );
    return;
  }
  const php = await command('php', ['-r', 'echo PHP_VERSION;']);
  if (php.exitCode !== 0 || !php.output.trim()) {
    console.error('php not found');
    process.exitCode = 1;
    return;
  }
  try {
    assertPhpVersion(php.output);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  await mkdir(base, { recursive: true });
  const session = await mkdtemp(join(base, 'session-'));
  const secrets = [keys.publicKey, keys.privateKey];
  const cleanup = async () => {
    await Promise.all(
      [...activeChildren].map(async (child) => {
        const closed = once(child, 'close').catch(() => {});
        child.kill('SIGKILL');
        await closed;
      }),
    );
    if (interruption?.aborted) await rm(session, { recursive: true, force: true });
    else await rm(join(session, 'fixture-preparation/home'), { recursive: true, force: true });
  };
  const controller = new AbortController();
  interruption = controller.signal;
  let interrupted = false;
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    controller.abort();
    for (const child of activeChildren) child.kill('SIGKILL');
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const results = { environment: await environment(), runs: [] };
    const save = () => writeJson(resolve(root, options.out), redactResults(results, secrets));
    for (const entry of schedule(options, Boolean(keys.publicKey && keys.privateKey))) {
      const { repetition, measurement } = entry;
      const marketplace = entry.scenario.includes('marketplace');
      const directory = join(session, measurement, entry.scenario, String(repetition));
      let broker;
      let previous;
      try {
        const template = await fixture(marketplace, session, keys);
        let lock = template.lock;
        if (entry.scenario.startsWith('broker-')) {
          keys.packages = marketplacePackages(lock);
          broker = await startBroker(join(directory, 'broker'), marketplace, keys);
          secrets.push(broker.token, broker.masterKey);
          if (measurement === 'install') lock = await brokerLock(lock, broker);
        }
        for (const state of entry.states) {
          const runDirectory = join(directory, state);
          const auth = generateAuth({
            ...keys,
            brokerOrigin: broker?.origin,
            token: broker?.token,
          });
          const env = await composerEnvironment(runDirectory, auth);
          if (marketplace && !broker)
            await writeJson(join(env.COMPOSER_HOME, 'config.json'), {
              repositories: [{ type: 'composer', url: 'https://repo.magento.com/' }],
            });
          if (state === 'warm' && previous)
            await cp(join(previous, 'cache'), env.COMPOSER_CACHE_DIR, { recursive: true });
          const project = join(runDirectory, 'project');
          await writeJson(
            join(project, 'composer.json'),
            generateProject(template.project, broker?.origin),
          );
          if (measurement === 'install') await writeJson(join(project, 'composer.lock'), lock);
          const started = performance.now();
          const result = await command('composer', entry.argv, { cwd: project, env });
          const wallMs = performance.now() - started;
          const installed = await readFile(
            join(env.COMPOSER_VENDOR_DIR, 'composer/installed.json'),
            'utf8',
          )
            .then(JSON.parse)
            .catch(() => null);
          results.runs.push({
            measurement,
            scenario: entry.scenario,
            state,
            repetition,
            wallMs,
            exitCode: result.exitCode,
            packageCount: installed?.packages?.length ?? 0,
            timedOut: result.timedOut,
          });
          previous = runDirectory;
          await save();
          if (result.exitCode !== 0) throw new Error('Cache fill failed');
        }
      } catch {
        interruption.throwIfAborted();
        for (const state of entry.states)
          if (
            !results.runs.some(
              (run) =>
                run.measurement === measurement &&
                run.scenario === entry.scenario &&
                run.repetition === repetition &&
                run.state === state,
            )
          )
            results.runs.push({
              measurement,
              scenario: entry.scenario,
              state,
              repetition,
              wallMs: 0,
              exitCode: 1,
              packageCount: 0,
              timedOut: false,
            });
        await save();
      } finally {
        if (broker) await broker.stop();
        await rm(join(session, 'fixture-preparation/home'), { recursive: true, force: true });
        // Keep caches for inspection, but remove credentials and the broker keyring/database.
        for (const state of entry.states)
          await rm(join(directory, state, 'home'), { recursive: true, force: true });
        await rm(join(directory, 'broker'), { recursive: true, force: true });
      }
    }
    await rm(join(session, 'fixture-preparation/home'), { recursive: true, force: true });
    await save();
    console.log(markdown(results.runs));
    if (
      entries.some(
        (entry) =>
          !entry.skipped &&
          !results.runs.some(
            (run) =>
              run.measurement === entry.measurement &&
              run.scenario === entry.scenario &&
              run.exitCode === 0,
          ),
      )
    )
      process.exitCode = 1;
  } finally {
    await cleanup();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    interruption = undefined;
    if (interrupted) process.exit(130);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('bench:install failed (details suppressed)');
    process.exitCode = 1;
  });
