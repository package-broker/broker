#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HEALTH_TIMEOUT_MS = 60_000;
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
  // Initialization creates the lock table and may be applied by a different runner.
  const protectedApplications = applications.map((rows) =>
    rows.filter((row) => row.id !== 'core:0001_init'),
  );
  const appliers = protectedApplications.flatMap((rows, index) => (rows.length > 0 ? [index] : []));
  requireCheck(appliers.length === 1, 'migration-lock', 'expected exactly one migration applier');
  const applied = applications.flat().map((row) => row.id);
  requireCheck(
    new Set(applied).size === applied.length,
    'migration-lock',
    'migration applied twice',
  );
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
}

export function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    requireCheck(
      ['--image', '--verify-manifest'].includes(flag) && options[flag] === undefined,
      'arguments',
      'usage: smoke:docker --image <ref> [--verify-manifest <ref>] or --verify-manifest <ref>',
    );
    const value = args[index + 1];
    requireCheck(
      typeof value === 'string' && value.length > 0 && !value.startsWith('-'),
      'arguments',
      'expected an image reference',
    );
    options[flag] = value;
  }
  requireCheck(
    Object.keys(options).length > 0,
    'arguments',
    'specify --image or --verify-manifest',
  );
  return options;
}

export async function docker(
  args,
  check,
  { timeout = COMMAND_TIMEOUT_MS, signal, execute = exec } = {},
) {
  try {
    return await execute('docker', args, {
      encoding: 'utf8',
      timeout,
      signal,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const resource =
      check === 'cleanup-container'
        ? 'container'
        : check === 'cleanup-volume'
          ? 'volume'
          : undefined;
    if (
      resource &&
      error.code === 1 &&
      error.stderr?.trim() === `Error response from daemon: No such ${resource}: ${args.at(-1)}`
    ) {
      return { stdout: '', stderr: '' };
    }
    // Child errors include command arguments and captured output, potentially containing secrets.
    // eslint-disable-next-line preserve-caught-error -- discard subprocess errors to avoid exposing credentials.
    throw new Error(`${check}: Docker command failed or timed out (check daemon access and image)`);
  }
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

export async function smoke(options, { run = docker, signal, log = console.log } = {}) {
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
      verifyMigrationLogs(logs);
      for (const name of pair) await stop(name);
      log(
        'smoke:docker migration-lock: one protected applier, second lock participant, both healthy',
      );
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
