#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HEALTH_TIMEOUT_MS = 60_000;
const INGESTION_TIMEOUT_MS = 180_000;
const COMMAND_TIMEOUT_MS = 15_000;

function requireCheck(condition, check, detail) {
  if (!condition) throw new Error(`${check}: ${detail}`);
}

export function parseInspect(output) {
  let rows;
  try {
    rows = JSON.parse(output);
  } catch {
    throw new Error('inspect: invalid JSON');
  }
  requireCheck(Array.isArray(rows) && rows.length === 1, 'inspect', 'expected one container');
  const row = rows[0];
  requireCheck(typeof row?.State?.Running === 'boolean', 'inspect', 'missing container state');
  const port = row.NetworkSettings?.Ports?.['8787/tcp']?.find(
    (binding) => binding.HostIp === '127.0.0.1',
  )?.HostPort;
  return {
    running: row.State.Running,
    health: row.State.Health?.Status ?? 'missing',
    exitCode: row.State.ExitCode,
    port: typeof port === 'string' && /^\d+$/.test(port) ? Number(port) : undefined,
  };
}

export function parseManifest(output) {
  // Only descriptor Platform fields count; names and annotations can contain platform strings.
  return [...output.matchAll(/^\s*Platform:\s+(linux\/[a-z0-9_]+)(?:\/[a-z0-9_.-]+)?\s*$/gm)].map(
    (match) => match[1],
  );
}

export function verifyManifest(output) {
  const platforms = new Set(parseManifest(output));
  const missing = ['linux/amd64', 'linux/arm64'].filter((platform) => !platforms.has(platform));
  requireCheck(missing.length === 0, 'manifest', `missing platform(s): ${missing.join(', ')}`);
}

export function verifyMigrationLogs(outputs) {
  const events = outputs.map((output) =>
    output.split('\n').flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event !== null && typeof event === 'object' ? [event] : [];
      } catch {
        return [];
      }
    }),
  );
  const applications = events.map((rows) =>
    rows.filter((row) => typeof row.id === 'string' && row.message === `applied ${row.id}`),
  );
  const applied = applications.flat().map((row) => row.id);
  requireCheck(
    new Set(applied).size === applied.length,
    'migration-lock',
    'migration applied twice',
  );
  // The squashed baseline is applied before the lock exists. An init-only build
  // returns without entering the lock loop, and its peer may emit no events.
  if (applied.length === 1 && applied[0] === 'core:0001_init') return 'initialization';
  // Initialization creates the lock table and may be applied by a different runner.
  const protectedApplications = applications.map((rows) =>
    rows.filter((row) => row.id !== 'core:0001_init'),
  );
  const appliers = protectedApplications.flatMap((rows, index) => (rows.length > 0 ? [index] : []));
  requireCheck(appliers.length === 1, 'migration-lock', 'expected exactly one migration applier');
  const applier = appliers[0];
  requireCheck(
    events[applier].some((row) => row.message === 'migration lock acquired'),
    'migration-lock',
    'applier did not report acquiring the lock',
  );
  requireCheck(
    events.some(
      (rows, index) =>
        index !== applier &&
        rows.some(
          (row) =>
            typeof row.message === 'string' &&
            (row.message === 'migration lock acquired' ||
              /^migration lock is held by .+, waiting$/.test(row.message)),
        ),
    ),
    'migration-lock',
    'second container did not report waiting for or acquiring the lock',
  );
  return 'protected';
}

export function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    requireCheck(
      ['--image', '--verify-manifest', '--functional'].includes(flag) &&
        options[flag] === undefined,
      'arguments',
      'usage: smoke:docker --functional [--image <ref>] [--verify-manifest <ref>] or --image <ref> or --verify-manifest <ref>; without --image, --functional builds with CONFIG=fixtures/docker-smoke/broker.config.ts',
    );
    if (flag === '--functional') {
      options[flag] = true;
      continue;
    }
    const value = args[++index];
    requireCheck(
      typeof value === 'string' && value.length > 0 && !value.startsWith('-'),
      'arguments',
      'expected an image reference',
    );
    options[flag] = value;
  }
  requireCheck(
    options['--image'] || options['--verify-manifest'] || options['--functional'],
    'arguments',
    'specify --image, --verify-manifest or --functional',
  );
  return options;
}

export async function docker(
  args,
  check,
  { timeout = COMMAND_TIMEOUT_MS, signal, execute = exec, capture = () => {} } = {},
) {
  try {
    const result = await execute('docker', args, {
      encoding: 'utf8',
      timeout,
      signal,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
    });
    capture(result);
    return result;
  } catch (error) {
    capture({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' });
    const resource =
      check === 'cleanup-container'
        ? 'container'
        : check === 'cleanup-volume'
          ? 'volume'
          : check === 'cleanup-network'
            ? 'network'
            : undefined;
    if (
      resource &&
      error.code === 1 &&
      (error.stderr?.trim() === `Error response from daemon: No such ${resource}: ${args.at(-1)}` ||
        (resource === 'network' &&
          error.stderr?.trim() === `Error response from daemon: network ${args.at(-1)} not found`))
    ) {
      return { stdout: '', stderr: '' };
    }
    // Child errors include command arguments and captured output, potentially containing secrets.
    // eslint-disable-next-line preserve-caught-error -- discard subprocess errors to avoid exposing credentials.
    throw new Error(`${check}: Docker command failed or timed out (check daemon access and image)`);
  }
}

export function totpCode(secret, now = Date.now()) {
  requireCheck(
    typeof secret === 'string' && /^[A-Z2-7]{32}$/.test(secret),
    'setup',
    'invalid TOTP secret',
  );
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of secret) {
    value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
    value &= (1 << bits) - 1;
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export function verifyNoSecrets(outputs, secrets) {
  requireCheck(
    !outputs.some((output) => secrets.some((secret) => secret && output.includes(secret))),
    'secret-output',
    'sensitive value found in captured output (suppressed)',
  );
}

export function scrubDiagnostics(output, secrets) {
  let scrubbed = output;
  for (const secret of [...new Set(secrets)]
    .filter((value) => typeof value === 'string' && value)
    .sort((a, b) => b.length - a.length)) {
    scrubbed = scrubbed.replaceAll(secret, '[redacted]');
  }
  return scrubbed
    .replace(/^.*(?:password|token|secret|cookie|authorization)["']?\s*[:=].*$/gim, '[redacted]')
    .replace(/https?:\/\/[^\s/]+@[^\s"']+/gi, '[redacted]')
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
    .replace(/[A-Za-z0-9_+/-]{32,}={0,2}/g, '[redacted]');
}

export function verifyComposerInstall(lock, installed, brokerUrl) {
  const packages = lock?.packages;
  requireCheck(
    Array.isArray(packages) && packages.length === 1,
    'composer-lock',
    'expected one package',
  );
  const pkg = packages[0];
  let url;
  try {
    url = new URL(pkg.dist.url);
  } catch {
    throw new Error('composer-lock: missing broker dist URL');
  }
  requireCheck(
    pkg.name === 'docker-smoke/fixture' &&
      pkg.version === '1.0.0' &&
      url.origin === brokerUrl &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.startsWith('/smoke/dist/docker-smoke/fixture/') &&
      installed === "<?php\nreturn 'docker-smoke-installed';\n",
    'composer-install',
    'fixture contents or broker lock URL did not match',
  );
}

export async function prepareFunctionalFiles(directory, { execute = exec } = {}) {
  try {
    await execute(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=fixture',
        '-addext',
        'subjectAltName=DNS:fixture',
        '-keyout',
        join(directory, 'fixture.key'),
        '-out',
        join(directory, 'fixture.crt'),
      ],
      { timeout: COMMAND_TIMEOUT_MS, encoding: 'utf8' },
    );
  } catch {
    throw new Error('fixture-tls: could not generate local certificate (requires openssl)');
  }
}

const HTTP_ERRORS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'TimeoutError',
  'AbortError',
]);

// Serialized into the broker's existing Node runtime; no host-to-bridge routing is needed.
async function containerHttpRequest(url, init, timeout, request = fetch) {
  try {
    const response = await request(url, { ...init, signal: AbortSignal.timeout(timeout) });
    return {
      status: response.status,
      headers: [...response.headers].filter(([name]) => name !== 'set-cookie'),
      cookies: response.headers.getSetCookie(),
      body: await response.text(),
    };
  } catch (error) {
    return { error: error?.cause?.code ?? error?.name ?? 'request failed' };
  }
}

async function requestInContainer(broker, url, init, { run, timeout, signal, capture }) {
  // HTTP bodies contain expected credentials. Keep them private, just as with host fetch;
  // only the structured response is consumed, never logged or captured as command output.
  const result = await run(
    [
      'exec',
      broker,
      'node',
      '--eval',
      `(${containerHttpRequest.toString()})(...JSON.parse(process.argv[1])).then(result => process.stdout.write(JSON.stringify(result)))`,
      JSON.stringify([url, init, timeout]),
    ],
    'functional-http',
    { timeout, signal, capture: ({ stderr = '' }) => capture?.({ stderr }) },
  );
  const data = JSON.parse(result.stdout);
  if (data.error) {
    const code = HTTP_ERRORS.has(data.error) ? data.error : 'request failed';
    throw Object.assign(new Error('functional-http: request failed'), { code });
  }
  const headers = new Headers(data.headers);
  for (const cookie of data.cookies) headers.append('set-cookie', cookie);
  return new Response([204, 205, 304].includes(data.status) ? null : data.body, {
    status: data.status,
    headers,
  });
}

export async function functionalSmoke(
  options,
  {
    run = docker,
    signal,
    log = console.log,
    request,
    prepare = prepareFunctionalFiles,
    now = () => performance.now(),
    wallNow = Date.now,
    wait = delay,
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'pb-docker-functional-'));
  const containers = [];
  const aliases = new Map();
  const volumes = [];
  const network = `pb-smoke-${randomUUID()}`;
  const outputs = [];
  const httpDiagnostics = new Set();
  const containerOutputs = new Map();
  const secrets = [];
  const brokerUrl = 'http://127.0.0.1:8787';
  const capture = ({ stdout = '', stderr = '' }) => outputs.push(stdout, stderr);
  const command = async (args, check, extra = {}) => {
    const name = containers.find((name) =>
      args.some((arg) => arg === name || arg.startsWith(`${name}:`)),
    );
    const captureCommand = (result) => {
      capture(result);
      if (name) {
        const captured = containerOutputs.get(name) ?? [];
        captured.push(result.stdout ?? '', result.stderr ?? '');
        containerOutputs.set(name, captured);
      }
    };
    const result = await run(args, check, { signal, capture: captureCommand, ...extra });
    captureCommand(result);
    return result;
  };
  let broker;
  let diagnosticContainer;
  let failure;
  let stage = 'fixture TLS';
  let failedCheck;
  let networkAttempted = false;
  let lastProbe = 'not attempted';
  let lastHealth = 'unknown';
  const http = async (path, init, timeout = COMMAND_TIMEOUT_MS) => {
    const url = `${brokerUrl}${path}`;
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(timeout),
      ...(signal ? [signal] : []),
    ]);
    const response = await (request
      ? request(url, { ...init, signal: requestSignal })
      : requestInContainer(broker, url, init, {
          run,
          timeout,
          signal: requestSignal,
          capture: (result) => {
            capture(result);
            const captured = containerOutputs.get(broker) ?? [];
            captured.push(result.stderr ?? '');
            containerOutputs.set(broker, captured);
          },
        }));
    if (!response.ok) {
      const envelope = await response
        .clone()
        .json()
        .catch(() => null);
      const code = typeof envelope?.error?.code === 'string' ? envelope.error.code : 'unavailable';
      const paths = Array.isArray(envelope?.error?.details)
        ? envelope.error.details.flatMap((detail) =>
            typeof detail?.path === 'string' ? [detail.path] : [],
          )
        : [];
      httpDiagnostics.add(
        `HTTP ${response.status} ${init.method} ${path}: code=${JSON.stringify(code)}; details paths=${JSON.stringify(paths)}`,
      );
      if (path === '/_pb/sources' && response.status === 400 && paths.includes('/body/url')) {
        httpDiagnostics.add(
          'fixture URL rejected: build the smoke image with --build-arg CONFIG=fixtures/docker-smoke/broker.config.ts to allow HTTPS fixture:8443',
        );
      }
    }
    return response;
  };
  try {
    await prepare(directory);
    // Bind only the public CA; the nonroot broker cannot traverse the private host directory.
    await chmod(join(directory, 'fixture.crt'), 0o644);
    stage = 'Docker network and volume';
    networkAttempted = true;
    await command(['network', 'create', '--internal', network], 'functional-network');
    const volume = `pb-smoke-${randomUUID()}`;
    volumes.push(volume);
    await command(['volume', 'create', volume], 'functional-volume');
    const create = async (alias, image, args, extra = []) => {
      const name = `pb-smoke-${randomUUID()}`;
      containers.push(name);
      aliases.set(name, alias);
      diagnosticContainer = name;
      await command(
        [
          'create',
          '--pull',
          'never',
          '--name',
          name,
          '--network',
          ...(alias === 'composer' ? [`container:${broker}`] : [network, '--network-alias', alias]),
          ...extra,
          image,
          ...args,
        ],
        `functional-create-${alias}`,
      );
      return name;
    };
    stage = 'fixture startup';
    const fixtureDirectory = fileURLToPath(new URL('../fixtures/docker-smoke/', import.meta.url));
    const fixture = await create(
      'fixture',
      options['--image'],
      ['node', '/fixture/server.mjs'],
      [
        '--user',
        '0:0',
        '--mount',
        `type=bind,source=${fixtureDirectory},target=/fixture,readonly`,
        '--mount',
        `type=bind,source=${directory},target=/private,readonly`,
      ],
    );
    await command(['start', fixture], 'functional-fixture-start');
    const key = `pbmk_v1_${randomBytes(32).toString('base64url')}`;
    secrets.push(key);
    broker = await create(
      'broker',
      options['--image'],
      [],
      [
        '--mount',
        `type=volume,source=${volume},target=/data`,
        '--mount',
        `type=bind,source=${join(directory, 'fixture.crt')},target=/tmp/fixture.crt,readonly`,
        '--env',
        `PB_MASTER_KEY=${key}`,
        '--env',
        `PB_PUBLIC_URL=${brokerUrl}`,
        '--env',
        'PB_ORG_SLUG=docker-smoke',
        '--env',
        'PB_ORG_NAME=Docker smoke',
        '--env',
        'NODE_EXTRA_CA_CERTS=/tmp/fixture.crt',
      ],
    );
    stage = 'broker startup';
    await command(['start', broker], 'functional-start');
    const deadline = now() + HEALTH_TIMEOUT_MS;
    let ready = false;
    while (now() < deadline) {
      signal?.throwIfAborted();
      // Full inspect output contains the container environment, including its master key.
      const state = parseInspect(
        (
          await command(
            [
              'inspect',
              '--format',
              '[{"State":{"Running":{{json .State.Running}},"Health":{"Status":{{json .State.Health.Status}}}}}]',
              broker,
            ],
            'functional-health',
            {
              timeout: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, Math.floor(deadline - now()))),
            },
          )
        ).stdout,
      );
      lastHealth = state.health;
      requireCheck(now() < deadline, 'functional-health', 'deadline exceeded');
      requireCheck(
        state.running && !['missing', 'unhealthy'].includes(state.health),
        'functional-health',
        'broker is not healthy',
      );
      if (state.health === 'healthy') {
        try {
          const response = await http(
            '/health/ready',
            { method: 'GET', redirect: 'error' },
            Math.max(1, Math.min(2000, Math.floor(deadline - now()))),
          );
          lastProbe = `HTTP ${response.status}`;
          await response.body?.cancel();
          ready = response.status === 200;
        } catch (error) {
          lastProbe = HTTP_ERRORS.has(error?.code) ? error.code : 'request failed or timed out';
        }
        signal?.throwIfAborted();
        requireCheck(now() < deadline, 'functional-health', 'deadline exceeded');
        if (ready) break;
      }
      await wait(Math.min(250, deadline - now()), undefined, { signal });
    }
    requireCheck(ready, 'functional-health', 'no ready broker within 60 s');
    // The generated setup token stays on the temporary mounted data volume until copied to a private directory.
    stage = 'admin bootstrap';
    await command(
      [
        'exec',
        broker,
        'pb',
        'admin',
        'bootstrap',
        '--sqlite',
        '/data/broker.sqlite',
        '--email',
        'docker-smoke@example.test',
        '--token-file',
        '/data/setup-token',
      ],
      'functional-bootstrap',
    );
    await command(
      ['cp', `${broker}:/data/setup-token`, join(directory, 'setup-token')],
      'functional-token-file',
    );
    const token = (await readFile(join(directory, 'setup-token'), 'utf8')).trim();
    secrets.push(token);
    requireCheck(/^[A-Za-z0-9_-]{43}$/.test(token), 'setup', 'missing setup token');
    let cookie = '';
    let csrf = '';
    const api = async (path, body, expected, method = 'POST', allowReauth = false) => {
      let response;
      try {
        response = await http(path, {
          method,
          redirect: 'error',
          headers: {
            origin: brokerUrl,
            'content-type': 'application/json',
            ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        throw new Error('functional-api: request failed');
      }
      if (allowReauth && response.status === 403) {
        const envelope = await response
          .clone()
          .json()
          .catch(() => null);
        if (envelope?.error?.code === 'reauth_required') return response;
      }
      if (response.status !== expected) failedCheck = `HTTP ${response.status}`;
      requireCheck(
        response.status === expected,
        'functional-api',
        `unexpected HTTP status (${response.status})`,
      );
      return response;
    };
    stage = 'local setup';
    const started = await api('/_pb/auth/local/setup/start', { token }, 200);
    const { secret } = await started.json().catch(() => {
      throw new Error('setup: invalid response');
    });
    secrets.push(secret);
    const password = `smoke-${randomBytes(32).toString('base64url')}`;
    secrets.push(password);
    const setupTime = wallNow();
    const code = totpCode(secret, setupTime);
    secrets.push(code);
    const finished = await api('/_pb/auth/local/setup/finish', { token, password, code }, 204);
    const cookies = finished.headers.getSetCookie().map((entry) => entry.split(';')[0]);
    cookie = cookies.filter((entry) => /^__Host-pb_(session|csrf)=/.test(entry)).join('; ');
    csrf = cookies.find((entry) => entry.startsWith('__Host-pb_csrf='))?.split('=')[1];
    secrets.push(...cookies.map((entry) => entry.split('=')[1]));
    requireCheck(
      csrf && cookies.some((entry) => entry.startsWith('__Host-pb_session=')),
      'setup',
      'missing session or CSRF cookie',
    );
    stage = 'session project configuration';
    await api('/_pb/session', undefined, 200, 'GET');
    const project = await (
      await api('/_pb/projects', { slug: 'smoke', name: 'Docker smoke' }, 201)
    ).json();
    requireCheck(
      typeof project.id === 'string' && project.id.length > 0,
      'functional-project',
      'missing project ID',
    );
    stage = 'session source configuration';
    const source = await (
      await api(
        '/_pb/sources',
        {
          name: 'Local fixture',
          ecosystem: 'composer',
          type: 'composer_repository',
          url: 'https://fixture:8443/',
          pollIntervalSeconds: 60,
          config: {
            selection: {
              packages: ['docker-smoke/fixture'],
              patterns: [],
              expandPatterns: false,
            },
            distHosts: [],
            mirrorsFallback: false,
          },
        },
        201,
      )
    ).json();
    requireCheck(
      typeof source.id === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(source.id),
      'functional-source',
      'missing source ID',
    );
    await api(`/_pb/sources/${source.id}/names`, { pattern: 'docker-smoke/fixture' }, 201);
    await api(`/_pb/sources/${source.id}/enable`, undefined, 204);
    await api(`/_pb/projects/smoke/sources/${source.id}/attachment`, {}, 204, 'PUT');
    const readSourceStatus = async (diagnostic = false) => {
      const listing = await (
        await api('/_pb/projects/smoke/sources', undefined, 200, 'GET')
      ).json();
      const row = listing.items?.find((item) => item.id === source.id);
      if (diagnostic) {
        // The source list exposes sync time and status, but no last-error code.
        httpDiagnostics.add(
          `source status: ${JSON.stringify({
            attached: row?.attached ?? false,
            status: row?.status ?? 'missing',
            pollIntervalSeconds: row?.pollIntervalSeconds ?? null,
            lastSuccessAt: row?.lastSuccessAt ?? null,
            lastErrorCode: 'not exposed by source API',
          })}`,
        );
      }
      return row;
    };
    const attached = await readSourceStatus();
    requireCheck(
      attached?.attached === true && ['active', 'degraded', 'failing'].includes(attached.status),
      'functional-source',
      'fixture source is not attached and enabled',
    );
    const names = await (
      await api(`/_pb/sources/${source.id}/names`, undefined, 200, 'GET')
    ).json();
    requireCheck(
      names.items?.some((item) => item.pattern === 'docker-smoke/fixture'),
      'functional-source',
      'fixture package name is not registered',
    );
    stage = 'session read token';
    const issueToken = (allowReauth) =>
      api(
        '/_pb/me/tokens',
        {
          name: 'Docker smoke read',
          scope: 'read',
          readOnly: true,
          lifetimeDays: 1,
          projectMode: 'selected',
          projectIds: [project.id],
        },
        201,
        'POST',
        allowReauth,
      );
    let issuance = await issueToken(true);
    if (issuance.status === 403) {
      await issuance.body?.cancel();
      stage = 'session reauthentication';
      // Setup consumes its TOTP step. Wait for a later step instead of replaying its code.
      const nextStep = (Math.floor(setupTime / 30_000) + 1) * 30_000;
      const remaining = nextStep - wallNow();
      if (remaining > 0) await wait(remaining, undefined, { signal });
      signal?.throwIfAborted();
      const reauthTime = wallNow();
      requireCheck(reauthTime >= nextStep, 'reauth', 'fresh TOTP step unavailable');
      const reauthCode = totpCode(secret, reauthTime);
      secrets.push(reauthCode);
      await api('/_pb/auth/local/reauth', { password, code: reauthCode }, 204);
      stage = 'session read token';
      issuance = await issueToken(false);
    }
    const issued = await issuance.json();
    secrets.push(issued.token);
    requireCheck(
      typeof issued.token === 'string' && issued.token.length > 0,
      'functional-token',
      'missing read token',
    );
    secrets.push(Buffer.from(`token:${issued.token}`).toString('base64'));
    stage = 'fixture ingestion';
    // No management sync route exists. Allow minute-based source polling plus job dispatch/fanout.
    const ingestionDeadline = now() + INGESTION_TIMEOUT_MS;
    let ingested = false;
    try {
      while (now() < ingestionDeadline) {
        signal?.throwIfAborted();
        const response = await http(
          '/smoke/p2/docker-smoke/fixture.json',
          {
            method: 'GET',
            redirect: 'error',
            headers: {
              authorization: `Basic ${Buffer.from(`token:${issued.token}`).toString('base64')}`,
            },
          },
          Math.max(1, Math.min(COMMAND_TIMEOUT_MS, Math.floor(ingestionDeadline - now()))),
        );
        if (response.status === 200) {
          const metadata = await response.json();
          ingested = metadata.packages?.['docker-smoke/fixture']?.some(
            (pkg) => pkg.version === '1.0.0',
          );
        } else {
          await response.body?.cancel();
          requireCheck(
            [404, 503].includes(response.status),
            'fixture-ingestion',
            'metadata request failed',
          );
        }
        signal?.throwIfAborted();
        requireCheck(now() < ingestionDeadline, 'fixture-ingestion', 'deadline exceeded');
        if (ingested) break;
        await wait(Math.min(250, ingestionDeadline - now()), undefined, { signal });
      }
      requireCheck(ingested, 'fixture-ingestion', 'no fixture version within 180 s');
    } finally {
      const originalCheck = failedCheck;
      try {
        await readSourceStatus(true);
      } catch {
        httpDiagnostics.add('source status: unavailable (status read failed or interrupted)');
      } finally {
        failedCheck = originalCheck;
      }
    }
    await writeFile(
      join(directory, 'composer.json'),
      JSON.stringify({
        name: 'docker-smoke/project',
        require: { 'docker-smoke/fixture': '1.0.0' },
        repositories: [{ type: 'composer', url: `${brokerUrl}/smoke` }, { 'packagist.org': false }],
        config: {
          'secure-http': false,
          'allow-plugins': false,
          audit: { 'block-insecure': false },
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, 'auth.json'),
      JSON.stringify({
        'http-basic': { [new URL(brokerUrl).host]: { username: 'token', password: issued.token } },
      }),
      { mode: 0o600 },
    );
    stage = 'Composer install';
    const composer = await create(
      'composer',
      'composer:2',
      [
        'install',
        '--no-interaction',
        '--no-plugins',
        '--no-scripts',
        '--no-progress',
        '--prefer-dist',
      ],
      [
        '--mount',
        `type=bind,source=${directory},target=/work`,
        '--workdir',
        '/work',
        '--user',
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        '--env',
        'COMPOSER_HOME=/tmp/composer',
        '--env',
        'COMPOSER_CACHE_DIR=/tmp/cache',
        '--env',
        'COMPOSER_ALLOW_SUPERUSER=1',
        '--env',
        'COMPOSER_NO_AUDIT=1',
      ],
    );
    await command(['start', '--attach', composer], 'functional-composer', { timeout: 120_000 });
    const exit = await command(['wait', composer], 'functional-composer-exit');
    requireCheck(exit.stdout.trim() === '0', 'composer-install', 'Composer exited unsuccessfully');
    const lock = JSON.parse(await readFile(join(directory, 'composer.lock'), 'utf8'));
    const installed = await readFile(
      join(directory, 'vendor/docker-smoke/fixture/installed.php'),
      'utf8',
    );
    verifyComposerInstall(lock, installed, brokerUrl);
    // Keep captured output private even when a future client version prints credentials.
    for (const file of ['composer.lock', 'vendor/composer/installed.json']) {
      outputs.push(await readFile(join(directory, file), 'utf8'));
    }
  } catch {
    // Files, HTTP bodies and subprocess errors may carry credentials.
    failure = new Error(`functional: ${stage} failed${failedCheck ? ` (${failedCheck})` : ''}`);
  } finally {
    if (broker) {
      try {
        await command(['logs', broker], 'functional-logs', { signal: undefined });
      } catch {
        diagnosticContainer = broker;
        failure ??= new Error('functional: could not capture broker logs');
      }
    }
    // Snapshot before removal so sentinel and cleanup failures can also report diagnostics.
    const diagnostics = new Map();
    for (const name of containers) {
      const snapshot = [];
      if (name === broker) {
        snapshot.push(
          `startup probe: GET ${brokerUrl}/health/ready (inside broker); last result: ${lastProbe}; Docker health: ${lastHealth}`,
        );
      }
      for (const [label, args, check] of [
        ['last 40 log lines', ['logs', '--tail', '40', name], 'functional-diagnostic-logs'],
        [
          'exit state',
          [
            'inspect',
            '--format',
            '{"Status":{{json .State.Status}},"Running":{{json .State.Running}},"ExitCode":{{json .State.ExitCode}},"OOMKilled":{{json .State.OOMKilled}},"Error":{{json .State.Error}}}',
            name,
          ],
          'functional-diagnostic-state',
        ],
      ]) {
        try {
          const result = await command(args, check, { signal: undefined });
          snapshot.push(`${label}:\n${result.stdout}${result.stderr}`);
        } catch {
          snapshot.push(`${label}: unavailable (Docker command failed or timed out)`);
        }
      }
      diagnostics.set(name, snapshot);
    }
    const removed = await Promise.allSettled(
      containers.map((name) =>
        command(['rm', '--force', '--volumes', name], 'cleanup-container', { signal: undefined }),
      ),
    );
    const removedVolumes = await Promise.allSettled(
      volumes.map((name) =>
        command(['volume', 'rm', '--force', name], 'cleanup-volume', { signal: undefined }),
      ),
    );
    const removedNetwork = await Promise.allSettled(
      networkAttempted
        ? [command(['network', 'rm', network], 'cleanup-network', { signal: undefined })]
        : [],
    );
    if (
      [...removed, ...removedVolumes, ...removedNetwork].some(
        (result) => result.status === 'rejected',
      )
    ) {
      failure = new Error('functional-cleanup: resource removal failed');
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      failure = new Error('functional-cleanup: temporary directory removal failed');
    }
    try {
      verifyNoSecrets(outputs, secrets);
    } catch (error) {
      failure = error;
      diagnosticContainer =
        [...containerOutputs].find(([, captured]) =>
          captured.some((output) => secrets.some((secret) => secret && output.includes(secret))),
        )?.[0] ?? diagnosticContainer;
    }
    for (const diagnostic of httpDiagnostics) {
      log(`smoke:docker functional diagnostics (broker): ${scrubDiagnostics(diagnostic, secrets)}`);
    }
    if (failure) {
      const selected = failure.message.startsWith('functional-cleanup:')
        ? containers
        : [diagnosticContainer];
      for (const name of selected) {
        for (const snapshot of diagnostics.get(name) ?? []) {
          log(
            `smoke:docker functional diagnostics (${aliases.get(name)}): ${scrubDiagnostics(snapshot, secrets)}`,
          );
        }
      }
    }
  }
  if (failure) throw failure;
  log(
    'smoke:docker functional: admin setup, source attachment, read token and Composer install passed; secret sentinel passed',
  );
}

// This function is serialized into the paired containers' startup commands.
export function migrationLogBarrier(
  index,
  fs,
  {
    now = Date.now,
    wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50),
    fail = () => process.exit(1),
  } = {},
) {
  return (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const acquired = event?.message === 'migration lock acquired';
    if (!acquired && !/^migration lock is held by .+, waiting$/.test(event?.message)) return;
    fs.writeFileSync(`/data/.pb-smoke-lock-${index}`, '');
    if (!acquired) return;
    const deadline = now() + 20_000;
    // Block the synchronous migration logger before any protected migration runs.
    while (!fs.existsSync(`/data/.pb-smoke-lock-${1 - index}`)) {
      if (now() >= deadline) {
        fail();
        return;
      }
      wait();
    }
  };
}

function coordinatedCommand(index) {
  return [
    'node',
    '--require',
    './umask.cjs',
    '--eval',
    `const barrier = (${migrationLogBarrier.toString()})(${index}, require('node:fs'));
const emit = console.log;
console.log = (...args) => { emit(...args); barrier(args[0]); };
process.argv[1] = require('node:path').resolve('./server.js');
import('./server.js').catch(() => process.exit(1));`,
  ];
}

export async function smoke(
  options,
  { run = docker, signal, log = console.log, functional = functionalSmoke } = {},
) {
  options = { ...options };
  const containers = [];
  const volumes = [];
  const key = `pbmk_v1_${randomBytes(32).toString('base64url')}`;
  const inspect = async (name, timeout = COMMAND_TIMEOUT_MS) =>
    parseInspect((await run(['inspect', name], 'inspect', { signal, timeout })).stdout);
  const createVolume = async () => {
    const name = `pb-smoke-${randomUUID()}`;
    volumes.push(name);
    await run(['volume', 'create', name], 'volume-create', { signal });
    return name;
  };
  const createContainer = async (volume, command = []) => {
    const name = `pb-smoke-${randomUUID()}`;
    containers.push(name);
    await run(
      [
        'create',
        '--name',
        name,
        '--mount',
        `type=volume,source=${volume},target=/data`,
        '--publish',
        '127.0.0.1::8787',
        '--env',
        `PB_MASTER_KEY=${key}`,
        '--env',
        'PB_PUBLIC_URL=http://127.0.0.1:8787',
        '--env',
        'PB_ORG_SLUG=docker-smoke',
        '--env',
        'PB_ORG_NAME=Docker smoke',
        options['--image'],
        ...command,
      ],
      'container-create',
      { signal },
    );
    return name;
  };
  const healthy = async (name, deadline) => {
    while (performance.now() < deadline) {
      const state = await inspect(
        name,
        Math.max(1, Math.min(COMMAND_TIMEOUT_MS, Math.floor(deadline - performance.now()))),
      );
      requireCheck(performance.now() <= deadline, 'health', 'deadline exceeded (60 s)');
      requireCheck(state.running, 'health', 'container exited before becoming healthy');
      requireCheck(state.health !== 'missing', 'health', 'image has no health check');
      requireCheck(state.health !== 'unhealthy', 'health', 'container became unhealthy');
      if (state.health === 'healthy') return;
      await delay(250, undefined, { signal });
    }
    throw new Error('health: deadline exceeded (60 s)');
  };
  const ready = async (name) => {
    const { port } = await inspect(name);
    requireCheck(port > 0 && port <= 65535, 'readiness', 'missing loopback port binding');
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
        signal: AbortSignal.any([AbortSignal.timeout(2000), ...(signal ? [signal] : [])]),
        redirect: 'error',
      });
      await response.body?.cancel();
    } catch {
      throw new Error('readiness: request failed');
    }
    requireCheck(response.status === 200, 'readiness', 'expected HTTP 200');
  };
  const stop = async (name) => {
    const started = performance.now();
    await run(['stop', '--time', '9', name], 'shutdown', { timeout: 10_000, signal });
    requireCheck(performance.now() - started <= 10_000, 'shutdown', 'stop exceeded 10 s');
    const state = await inspect(name);
    requireCheck(!state.running && state.exitCode === 0, 'shutdown', 'expected container exit 0');
  };
  let failure;
  try {
    if (options['--verify-manifest']) {
      const result = await run(
        ['buildx', 'imagetools', 'inspect', options['--verify-manifest']],
        'manifest',
        { signal },
      );
      verifyManifest(result.stdout);
      log('smoke:docker manifest: linux/amd64 and linux/arm64 verified');
    }
    if (options['--functional'] && !options['--image']) {
      options['--image'] = 'pb:docker-smoke';
      await run(
        [
          'build',
          '--build-arg',
          'CONFIG=fixtures/docker-smoke/broker.config.ts',
          '--tag',
          options['--image'],
          fileURLToPath(new URL('../', import.meta.url)),
        ],
        'smoke-image-build',
        { signal, timeout: 600_000 },
      );
      await run(['pull', 'composer:2'], 'smoke-composer-image', { signal, timeout: 120_000 });
    }
    if (options['--image']) {
      await run(['info', '--format', '{{.ServerVersion}}'], 'docker-access', { signal });
      const single = await createContainer(await createVolume());
      await run(['start', single], 'startup', { signal });
      await healthy(single, performance.now() + HEALTH_TIMEOUT_MS);
      const identity = await run(
        [
          'exec',
          single,
          'node',
          '-e',
          "console.log(JSON.stringify({uid:process.getuid(),init:require('node:fs').readFileSync('/proc/1/comm','utf8').trim()}))",
        ],
        'identity',
        { signal },
      );
      let processIdentity;
      try {
        processIdentity = JSON.parse(identity.stdout);
      } catch {
        throw new Error('identity: invalid process probe');
      }
      requireCheck(
        Number.isInteger(processIdentity?.uid) && processIdentity.uid > 0,
        'non-root',
        'expected a nonzero uid',
      );
      requireCheck(processIdentity.init === 'tini', 'pid-1', 'expected tini as PID 1');
      await ready(single);
      await stop(single);
      log('smoke:docker non-root, pid-1, health, readiness and shutdown passed');

      const volume = await createVolume();
      const pair = [
        await createContainer(volume, coordinatedCommand(0)),
        await createContainer(volume, coordinatedCommand(1)),
      ];
      // Settle both starts before cleanup, even if one fails.
      const starts = await Promise.allSettled(
        pair.map((name) => run(['start', name], 'concurrent-start', { signal })),
      );
      for (const result of starts) if (result.status === 'rejected') throw result.reason;
      const deadline = performance.now() + HEALTH_TIMEOUT_MS;
      for (const name of pair) {
        await healthy(name, deadline);
        await ready(name);
      }
      const logs = [];
      for (const name of pair) {
        const result = await run(['logs', name], 'migration-logs', { signal });
        logs.push(`${result.stdout}\n${result.stderr}`);
      }
      const migrationMode = verifyMigrationLogs(logs);
      for (const name of pair) await stop(name);
      log(
        migrationMode === 'initialization'
          ? 'smoke:docker migration initialization: one applier, both healthy; no post-initialization migrations to exercise the lock'
          : 'smoke:docker migration-lock: one protected applier, second lock participant, both healthy',
      );
      if (options['--functional']) await functional(options, { run, signal, log });
    }
  } catch (error) {
    failure = error;
  } finally {
    // Do not cancel cleanup when the caller interrupts a check.
    const removed = await Promise.allSettled(
      containers.map((name) => run(['rm', '--force', '--volumes', name], 'cleanup-container')),
    );
    const removedVolumes = await Promise.allSettled(
      volumes.map((name) => run(['volume', 'rm', '--force', name], 'cleanup-volume')),
    );
    if ([...removed, ...removedVolumes].some((result) => result.status === 'rejected')) {
      failure = new Error(
        `${failure ? `${failure.message}; ` : ''}cleanup: container or volume removal failed; check Docker daemon access`,
        {
          cause: failure,
        },
      );
    }
  }
  if (failure) throw failure;
}

async function main() {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    await smoke(parseArgs(process.argv.slice(2)), { signal: controller.signal });
  } catch (error) {
    console.error(`smoke:docker FAIL ${controller.signal.aborted ? 'interrupted' : error.message}`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
