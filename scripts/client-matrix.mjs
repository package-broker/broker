import { assertIntegrationEvidence } from './client-matrix-api.mjs';
import { matrixJwks } from './client-matrix-oidc.mjs';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, stripVTControlCharacters } from 'node:util';
import { gzipSync } from 'node:zlib';

class HarnessError extends Error {}
class StepFailure extends Error {}

export const harnessAssert = {
  ok(value, message) {
    if (!value) throw new HarnessError(message);
  },
  equal(actual, expected, message) {
    if (actual !== expected) throw new HarnessError(message);
  },
};

export function safeFailureReason(error) {
  return error instanceof HarnessError ? error.message : 'Harness operation failed';
}

export async function matrixStep(step, action, verbose = false) {
  if (verbose) console.log(`client-matrix: ${step} starting`);
  try {
    const result = await action();
    if (verbose) console.log(`client-matrix: ${step} passed`);
    return result;
  } catch (error) {
    if (error instanceof StepFailure) throw error;
    const message = safeFailureReason(error);
    throw new StepFailure(`${step} failed: ${message}`);
  }
}

export function parseSelection(args, env) {
  const selected = { ...env };
  let verboseSteps = false;
  let debug = env.CLIENT_MATRIX_DEBUG === '1';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--verbose-steps') verboseSteps = true;
    else if (args[i] === '--debug') debug = true;
    else if (args[i] === '--client' && Object.hasOwn(CLIENT_VERSIONS, args[i + 1])) {
      selected.CLIENT = args[++i];
      selected.CLIENT_VERSION = CLIENT_VERSIONS[selected.CLIENT];
    } else throw new HarnessError('Unsupported harness arguments');
  }
  if (selected.CLIENT_VERSION === undefined)
    selected.CLIENT_VERSION = CLIENT_VERSIONS[selected.CLIENT];
  return { ...selectClient(selected), verboseSteps: verboseSteps || debug, debug };
}

export const CLIENT_VERSIONS = Object.freeze({
  composer: '2.10',
  npm: '11.17.0',
  pnpm: '12.5.1',
  yarn: '4.9.2',
});
export const PACKAGES = ['matrix-public', '@matrix/private'];
export const PUBLISH_PACKAGES = [
  'matrix-publish-active',
  '@matrix-publish/active',
  'matrix-publish-held',
  '@matrix-publish/held',
];
export const CONTENT = 'module.exports = "client-matrix fixture";\n';

export function selectClient(env) {
  const client = env.CLIENT;
  const version = env.CLIENT_VERSION;
  if (!Object.hasOwn(CLIENT_VERSIONS, client) || CLIENT_VERSIONS[client] !== version) {
    throw new HarnessError('Unsupported client selection');
  }
  return { client, version };
}

export function checkVersion(result, client, version) {
  const matches =
    client === 'composer'
      ? result.stdout.startsWith(`Composer version ${version}.`)
      : result.stdout.trim() === version;
  harnessAssert.ok(result.code === 0 && matches, 'Installed client version mismatch');
}

export function checkInstalledPackage(name, metadata, content) {
  let manifest;
  try {
    manifest = JSON.parse(metadata);
  } catch {
    throw new HarnessError('Invalid installed manifest');
  }
  harnessAssert.ok(manifest?.name === name, 'Installed package name mismatch');
  harnessAssert.ok(manifest.version === '1.0.0', 'Installed package version mismatch');
  harnessAssert.ok(content === CONTENT, 'Installed package content mismatch');
}

export function clientCommands(client) {
  const native = (args) => ({ command: client, args });
  return {
    install: native(
      client === 'yarn'
        ? ['install']
        : client === 'pnpm'
          ? ['install', '--ignore-scripts', '--no-frozen-lockfile']
          : ['install', '--ignore-scripts', '--no-audit'],
    ),
    publish: native(
      client === 'yarn'
        ? ['npm', 'publish', '--access', 'public']
        : [
            'publish',
            '--ignore-scripts',
            '--provenance=false',
            '--access',
            'public',
            ...(client === 'pnpm' ? ['--no-git-checks'] : []),
          ],
    ),
    audit: native(client === 'yarn' ? ['npm', 'audit', '--json'] : ['audit', '--json']),
    whoami: native(client === 'yarn' ? ['npm', 'whoami'] : ['whoami']),
    // Yarn 4 has no ping command. Its step is explicitly skipped.
    ping: client === 'yarn' ? null : native(client === 'pnpm' ? ['ping'] : ['ping', '--json']),
  };
}

export function checkResult(result, step, client) {
  const identity =
    client === 'yarn'
      ? result.output.split(/\r?\n/).includes('➤ YN0000: matrix-bot')
      : result.output.trim() === 'matrix-bot';
  const valid =
    step === 'audit-without-proxy'
      ? result.code !== 0 && /unsupported|501|requires an npmjs/is.test(result.output)
      : result.code === 0 && (step !== 'whoami' || identity);
  if (!valid) throw new HarnessError(`Client matrix mismatch: ${step}`);
}

export function checkTraffic(routes, audits, client = 'npm') {
  for (const route of [
    ...PACKAGES.flatMap((name) => [`packument:${name}`, `tarball:${name}`]),
    'whoami',
    ...(client === 'yarn' ? [] : ['ping']),
    'audit:200',
    'audit:501',
  ]) {
    harnessAssert.ok(routes.includes(route), `Missing client traffic: ${route}`);
  }
  harnessAssert.ok(audits.length > 0, 'Missing forwarded audit');
  for (const body of audits)
    harnessAssert.ok(
      isDeepStrictEqual(body, { 'matrix-public': ['1.0.0'] }),
      'Unexpected public audit body',
    );
}

export async function observeResponse(routes, request, response, auditStatus) {
  const path = decodeURIComponent(new URL(request.url).pathname);
  if (request.method === 'PUT' && PUBLISH_PACKAGES.some((name) => path === `/alpha/npm/${name}`)) {
    const name = path.slice('/alpha/npm/'.length);
    const held = name.endsWith('held');
    harnessAssert.equal(response.status, held ? 202 : 201, 'Unexpected publish status');
    const body = await response.clone().json();
    harnessAssert.equal(body.ok, true, 'Publish was not accepted');
    harnessAssert.equal(body.id, `${name}@1.0.0`, 'Unexpected publish identity');
    if (held)
      harnessAssert.ok(
        body.held?.approval === true && body.held?.scan === false,
        'Missing publish approval hold',
      );
    routes.push(`publish:${name}:${response.status}`);
    return;
  }
  if (path.includes('/security/')) {
    harnessAssert.equal(response.status, auditStatus, 'Unexpected audit status');
    const body = await response.clone().json();
    if (auditStatus === 200) harnessAssert.ok(isDeepStrictEqual(body, {}), 'Unexpected audit body');
    else harnessAssert.ok(body.code === 'unsupported', 'Unexpected audit refusal');
    routes.push(`audit:${response.status}`);
  } else if (path.endsWith('/-/whoami')) {
    harnessAssert.equal(response.status, 200, 'Unexpected whoami status');
    harnessAssert.ok(
      isDeepStrictEqual(await response.clone().json(), { username: 'matrix-bot' }),
      'Unexpected whoami body',
    );
    routes.push('whoami');
  } else if (path.endsWith('/-/ping')) {
    harnessAssert.equal(response.status, 200, 'Unexpected ping status');
    harnessAssert.ok(isDeepStrictEqual(await response.clone().json(), {}), 'Unexpected ping body');
    routes.push('ping');
  } else {
    for (const name of PACKAGES) {
      if (path === `/alpha/npm/${name}` && response.status === 200)
        routes.push(`packument:${name}`);
      if (path.startsWith(`/alpha/npm/${name}/-/`) && response.status === 200)
        routes.push(`tarball:${name}`);
    }
  }
}

function tarEntry(path, text) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(512);
  header.write(path);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  header.write(
    `${header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0')}\0 `,
    148,
  );
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

const tarballs = new Map(
  PACKAGES.map((name) => [
    name,
    gzipSync(
      Buffer.concat([
        tarEntry(
          'package/package.json',
          JSON.stringify({ name, version: '1.0.0', main: 'index.js' }),
        ),
        tarEntry('package/index.js', CONTENT),
        Buffer.alloc(1024),
      ]),
    ),
  ]),
);

export async function fixtureReply(request, audits) {
  const url = new URL(request.url);
  if (url.href === 'https://token.actions.githubusercontent.com/.well-known/jwks') {
    harnessAssert.ok(
      request.method === 'GET' &&
        !request.headers.has('authorization') &&
        !request.headers.has('cookie'),
      'Invalid JWKS fixture request',
    );
    return Response.json(matrixJwks);
  }
  harnessAssert.ok(
    ['https://registry.npmjs.org', 'https://npm.matrix.test'].includes(url.origin),
    'Unexpected outbound destination',
  );
  harnessAssert.ok(
    !request.headers.has('authorization') && !request.headers.has('cookie'),
    'Credentials reached fixture',
  );
  if (
    request.method === 'POST' &&
    url.origin === 'https://registry.npmjs.org' &&
    url.pathname === '/-/npm/v1/security/advisories/bulk'
  ) {
    const body = await request.json();
    harnessAssert.ok(
      isDeepStrictEqual(body, { 'matrix-public': ['1.0.0'] }),
      'Unexpected public audit body',
    );
    audits.push(body);
    return Response.json({});
  }
  harnessAssert.ok(request.method === 'GET', 'Unexpected fixture method');
  const name = url.hostname === 'registry.npmjs.org' ? PACKAGES[0] : PACKAGES[1];
  const bytes = tarballs.get(name);
  const tarball = `/${name}/-/${name.split('/').at(-1)}-1.0.0.tgz`;
  if (decodeURIComponent(url.pathname) === tarball) {
    return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
  }
  if (decodeURIComponent(url.pathname) !== `/${name}`)
    return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json(
    {
      name,
      'dist-tags': { latest: '1.0.0' },
      time: { '1.0.0': '2026-01-01T00:00:00.000Z' },
      versions: {
        '1.0.0': {
          name,
          version: '1.0.0',
          dist: {
            tarball: `${url.origin}${tarball}`,
            integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
            shasum: createHash('sha1').update(bytes).digest('hex'),
          },
        },
      },
    },
    { headers: { etag: '"client-matrix-v1"' } },
  );
}

export function redactClientOutput(output) {
  return stripVTControlCharacters(output)
    .replace(/((?:#\/npm-login|\/-\/v1\/done)\/)[A-Za-z0-9_-]{43}/g, '$1[REDACTED]')
    .replace(/pb_[a-z0-9_-]+/gi, '[REDACTED]')
    .replace(/(_authToken["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/((?:authorization|cookie|set-cookie)["']?\s*[:=]\s*)[^\r\n]*/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/]*@/gi, '$1[REDACTED]@')
    .replace(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[REDACTED]');
}

export function runCommand(
  command,
  args,
  cwd,
  env,
  { debug = false, log = console.log, input } = {},
) {
  if (debug) log(`client-matrix: command ${redactClientOutput([command, ...args].join(' '))}`);
  return new Promise((resolve) => {
    const complete = (error, stdout = '', stderr = '') => {
      const result = {
        code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        stdout,
        output: `${stdout}${stderr}${error && !stdout && !stderr ? 'Command could not complete' : ''}`,
      };
      if (debug) log(`client-matrix: exit=${result.code}\n${redactClientOutput(result.output)}`);
      resolve(result);
    };
    try {
      const child = execFile(
        command,
        args,
        {
          cwd,
          env,
          encoding: 'utf8',
          timeout: 60_000,
          killSignal: 'SIGKILL',
          maxBuffer: 4 * 1024 * 1024,
        },
        complete,
      );
      if (input !== undefined) {
        child.stdin.on('error', () => undefined);
        child.stdin.end(input);
      }
    } catch (error) {
      complete(error);
    }
  });
}

export async function preparePublisher(
  directory,
  client,
  registry,
  token,
  name,
  { debug = false, run = runCommand } = {},
) {
  const publisher = await prepareClient(directory, client, registry, token);
  await writeFile(
    join(publisher.project, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      main: 'index.js',
      license: 'MIT',
      files: ['index.js', 'README.md'],
    }),
  );
  await writeFile(join(publisher.project, 'index.js'), 'module.exports = true;\n');
  await writeFile(join(publisher.project, 'README.md'), '# Publish fixture\n');
  if (client === 'yarn') {
    const command = clientCommands(client).install;
    const result = await run(command.command, command.args, publisher.project, publisher.env, {
      debug,
    });
    checkResult(result, 'publisher install', client);
  }
  return publisher;
}

export async function prepareClient(directory, client, registry, token) {
  const project = join(directory, 'client');
  await mkdir(project, { recursive: true });
  const npmrc = join(project, '.npmrc');
  await writeFile(
    npmrc,
    `registry=${registry}\n//${registry.split('//')[1]}:_authToken=${token}\nfetch-retries=0\naudit=false\nfund=false\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({
      name: 'matrix-consumer',
      private: true,
      version: '1.0.0',
      ...(client === 'pnpm' ? {} : { packageManager: `${client}@${CLIENT_VERSIONS[client]}` }),
      dependencies: Object.fromEntries(PACKAGES.map((name) => [name, '1.0.0'])),
    }),
  );
  await writeFile(
    join(project, 'pnpm-workspace.yaml'),
    JSON.stringify({
      packages: [],
      storeDir: join(directory, 'home', 'pnpm-store'),
      cacheDir: join(directory, 'home', 'pnpm-cache'),
      frozenLockfile: false,
      ignoreScripts: true,
      fetchRetries: 0,
    }),
  );
  await writeFile(join(project, 'yarn.lock'), '');
  await writeFile(
    join(project, '.yarnrc.yml'),
    JSON.stringify({
      npmRegistryServer: registry,
      npmAuditRegistry: registry,
      npmRegistries: {
        [registry.replace(/\/$/, '')]: { npmAuthToken: token, npmAlwaysAuth: true },
      },
      ignorePath: true,
      unsafeHttpWhitelist: ['127.0.0.1'],
      enableStrictSsl: true,
      nodeLinker: 'node-modules',
      enableScripts: false,
      enableTelemetry: false,
      enableGlobalCache: false,
      cacheFolder: join(directory, 'home', 'yarn-cache'),
      globalFolder: join(directory, 'home', 'yarn-global'),
      enableImmutableInstalls: false,
      enableHardenedMode: false,
      httpRetry: 0,
      networkSettings: {
        '*': { enableNetwork: false },
        '127.0.0.1': { enableNetwork: true },
      },
    }),
    { mode: 0o600 },
  );
  const env = {
    PATH: process.env.PATH,
    HOME: join(directory, 'home'),
    TMPDIR: join(directory, 'tmp'),
    XDG_CACHE_HOME: join(directory, 'home', '.cache'),
    XDG_CONFIG_HOME: join(directory, 'home', '.config'),
    XDG_DATA_HOME: join(directory, 'home', '.local', 'share'),
    XDG_STATE_HOME: join(directory, 'home', '.local', 'state'),
    CI: '1',
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_PROJECT_SPEC: '0',
    npm_config_userconfig: npmrc,
    npm_config_globalconfig: join(directory, 'empty-npmrc'),
    npm_config_cache: join(directory, 'home', 'npm-cache'),
    pnpm_config_state_dir: join(directory, 'home', 'pnpm-state'),
    npm_config_update_notifier: 'false',
    npm_config_fetch_retries: '0',
    npm_config_registry: registry,
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    YARN_ENABLE_TELEMETRY: '0',
    YARN_IGNORE_PATH: '1',
  };
  for (const key of [
    'HOME',
    'TMPDIR',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
  ])
    await mkdir(env[key], { recursive: true });
  await writeFile(env.npm_config_globalconfig, '');
  return { project, env };
}

async function main() {
  const selection = await matrixStep('selection', () =>
    parseSelection(process.argv.slice(2), process.env),
  );
  if (selection.client === 'composer') {
    await matrixStep(
      'composer version',
      async () => {
        const installed = await runCommand(
          'composer',
          ['--version'],
          process.cwd(),
          process.env,
          selection,
        );
        checkVersion(installed, 'composer', selection.version);
      },
      selection.verboseSteps,
    );
    // Preserve the existing Composer install, warm-lock and tamper coverage.
    await matrixStep(
      'composer install, warm-lock and tamper',
      async () => {
        const result = await runCommand(
          'pnpm',
          [
            'vitest',
            'run',
            '--project',
            'runtime-node',
            'src/registry-clients.test.ts',
            '-t',
            'composer',
          ],
          process.cwd(),
          process.env,
          selection,
        );
        checkResult(result, 'composer');
      },
      selection.verboseSteps,
    );
  } else {
    await matrixStep(`${selection.client} runtime harness`, async () => {
      const { runMatrix } = await import('./client-matrix-runtime.mjs');
      assertIntegrationEvidence(await runMatrix(selection));
    });
  }
  console.log(`client-matrix: ${selection.client} ${selection.version} passed`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      `client-matrix: ${error instanceof StepFailure ? error.message : 'Harness operation failed'}; raw client output withheld`,
    );
    process.exitCode = 1;
  });
}
