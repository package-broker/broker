import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';

// Measures one GitHub provider describe (PAT and App) inside workerd. Every upstream answer is
// synthetic and served from this process through the Miniflare outbound service.
const root = fileURLToPath(new URL('../../..', import.meta.url));
const packages = join(root, 'packages');
// A directory holding packages/<name>/src of another revision, for baseline runs.
const sources = join(process.env.GH_MEASURE_SOURCE_ROOT ?? root, 'packages');
const { Miniflare, Response, convertV4MiniflareOptions } = createRequire(
  join(packages, 'runtime-cloudflare', 'package.json'),
)('miniflare');
const esbuild = createRequire(join(packages, 'cli', 'package.json'))('esbuild');
const runFile = promisify(execFile);
const sampleIntervalMs = 25;
const REPO = 'acme/lib';
const API = 'https://api.github.com';
const GIT = `https://github.com/${REPO}.git`;
const enc = new TextEncoder();

const children = new Set();
const trackChild = ({ process: child }) => {
  child.once('spawn', () => {
    if (!child.spawnargs.some((arg) => /^workerd(?:\.exe)?$/.test(basename(arg)))) return;
    children.add(child);
    child.once('close', () => children.delete(child));
  });
};
channel('child_process').subscribe(trackChild);

async function bundle(outDir) {
  const outfile = join(outDir, 'worker.js');
  await esbuild.build({
    entryPoints: [fileURLToPath(new URL('./github-fill-measure.worker.mjs', import.meta.url))],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2023',
    conditions: ['workerd', 'worker', 'import'],
    mainFields: ['module', 'main'],
    external: ['node:*'],
    nodePaths: [join(packages, 'core', 'node_modules'), join(root, 'node_modules')],
    logLevel: 'error',
    plugins: [
      {
        name: 'workspace-src',
        setup(build) {
          build.onResolve({ filter: /^@package-broker\// }, ({ path }) => {
            const [, name, rest] = /^@package-broker\/([a-z0-9-]+)(?:\/(.+))?$/.exec(path);
            const base = name === 'e2e' ? packages : sources;
            return { path: join(base, name, 'src', `${rest ?? 'index'}.ts`) };
          });
        },
      },
    ],
  });
  return outfile;
}

function pkt(data) {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  const out = new Uint8Array(bytes.length + 4);
  out.set(enc.encode((bytes.length + 4).toString(16).padStart(4, '0')));
  out.set(bytes, 4);
  return out;
}
const FLUSH = enc.encode('0000');
const DELIM = enc.encode('0001');

function concat(parts) {
  return new Uint8Array(Buffer.concat(parts));
}

function object(type, data) {
  const oid = createHash('sha1')
    .update(enc.encode(`${type} ${data.length}\0`))
    .update(data)
    .digest('hex');
  return { type, data, oid };
}

function manifest(index, bytes) {
  const head = `{"name":"${REPO}","type":"library","description":"`;
  const tail = `","require":{"php":">=8.1"}}`;
  let padding = '';
  for (let n = 0; padding.length < bytes - head.length - tail.length; n++) {
    padding += createHash('sha256').update(`${index}:${n}`).digest('hex');
  }
  const text = head + padding.slice(0, bytes - head.length - tail.length) + tail;
  assert.equal(Buffer.byteLength(text), bytes);
  return text;
}

function repository(tags, bytes) {
  const objects = new Map();
  const refs = [];
  const texts = new Map();
  const add = (o) => (objects.set(o.oid, o), o);
  const release = (name, index) => {
    const text = manifest(index, bytes);
    const blob = add(object('blob', enc.encode(text)));
    texts.set(blob.oid, text);
    const tree = add(
      object('tree', concat([enc.encode('100644 composer.json\0'), Buffer.from(blob.oid, 'hex')])),
    );
    const when = 1_700_000_000 + index;
    const commit = add(
      object(
        'commit',
        enc.encode(
          `tree ${tree.oid}\nauthor Fixture <fixture@example.test> ${when} +0000\n` +
            `committer Fixture <fixture@example.test> ${when} +0000\n\nrelease ${index}\n`,
        ),
      ),
    );
    refs.push({ name, oid: commit.oid, blob: blob.oid });
  };
  for (let n = 0; n < tags; n++) release(`refs/tags/v1.${Math.floor(n / 100)}.${n % 100}`, n);
  release('refs/heads/main', tags);
  return { objects, refs, texts };
}

const TYPE_CODE = { commit: 1, tree: 2, blob: 3 };
const deflated = new WeakMap();

function pack(objects) {
  const header = Buffer.alloc(12);
  header.write('PACK');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts = [header];
  for (const o of objects) {
    const bytes = [];
    let first = (TYPE_CODE[o.type] << 4) | (o.data.length & 15);
    let rest = Math.floor(o.data.length / 16);
    while (rest > 0) {
      bytes.push(first | 0x80);
      first = rest & 0x7f;
      rest = Math.floor(rest / 128);
    }
    bytes.push(first);
    let body = deflated.get(o);
    if (body === undefined) deflated.set(o, (body = deflateSync(o.data)));
    parts.push(Buffer.from(bytes), body);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function closure(repo, oid, filter, root, out) {
  const o = repo.objects.get(oid);
  if (o === undefined || out.has(oid)) return;
  if (!root && filter === 'blob:none' && o.type === 'blob') return;
  out.set(oid, o);
  if (o.type === 'commit') {
    if (filter === 'tree:0') return;
    const tree = /^tree ([0-9a-f]{40})/.exec(Buffer.from(o.data).toString())[1];
    closure(repo, tree, filter, false, out);
  } else if (o.type === 'tree' && (filter === undefined || filter === 'blob:none')) {
    const nul = o.data.indexOf(0);
    closure(
      repo,
      Buffer.from(o.data.subarray(nul + 1, nul + 21)).toString('hex'),
      filter,
      false,
      out,
    );
  }
}

function lines(body) {
  const out = [];
  for (let at = 0; at < body.length;) {
    const len = Number.parseInt(Buffer.from(body.subarray(at, at + 4)).toString(), 16);
    if (len < 4) {
      at += 4;
      continue;
    }
    out.push(
      Buffer.from(body.subarray(at + 4, at + len))
        .toString()
        .trimEnd(),
    );
    at += len;
  }
  return out;
}

function upstream(repo, counts) {
  const json = (value) =>
    new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const count = (key) => (counts[key] = (counts[key] ?? 0) + 1);
  const tags = repo.refs.filter((ref) => ref.name.startsWith('refs/tags/'));
  const byCommit = new Map(repo.refs.map((ref) => [ref.oid, ref]));
  return async (request) => {
    const url = new URL(request.url);
    if (url.origin === API) {
      if (url.pathname === `/repos/${REPO}`) {
        count('api_repository');
        return json({ archived: false, default_branch: 'main', full_name: REPO });
      }
      if (url.pathname === `/repos/${REPO}/tags`) {
        count('api_tags');
        const page = Number(url.searchParams.get('page'));
        return json(
          tags
            .slice((page - 1) * 100, page * 100)
            .map((ref) => ({ name: ref.name.slice(10), commit: { sha: ref.oid } })),
        );
      }
      if (url.pathname === `/repos/${REPO}/branches/main`) {
        count('api_branch');
        const main = repo.refs.find((ref) => ref.name === 'refs/heads/main');
        return json({ name: 'main', commit: { sha: main.oid } });
      }
      if (url.pathname === '/graphql') {
        const { query } = JSON.parse(await request.text());
        const text = query.includes('byteSize text');
        count(text ? 'graphql_text' : 'graphql_size');
        const repository = {};
        for (const [, alias, commit] of query.matchAll(
          /(a\d+): object\(expression: "([0-9a-f]{40}):composer\.json"\)/g,
        )) {
          const blob = byCommit.get(commit).blob;
          const value = repo.texts.get(blob);
          repository[alias] = {
            byteSize: Buffer.byteLength(value),
            ...(text ? { text: value } : {}),
          };
        }
        return json({ data: { repository } });
      }
    }
    if (url.href === `${GIT}/info/refs?service=git-upload-pack`) {
      count('git_discover');
      return new Response(
        concat([
          pkt('# service=git-upload-pack\n'),
          FLUSH,
          pkt('version 2\n'),
          pkt('agent=git/fixture\n'),
          pkt('ls-refs\n'),
          pkt('fetch=shallow filter\n'),
          pkt('object-format=sha1\n'),
          FLUSH,
        ]),
        { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } },
      );
    }
    if (url.href === `${GIT}/git-upload-pack` && request.method === 'POST') {
      const wire = lines(new Uint8Array(await request.arrayBuffer()));
      const result = { headers: { 'content-type': 'application/x-git-upload-pack-result' } };
      if (wire.includes('command=ls-refs')) {
        count('git_ls_refs');
        return new Response(
          concat([...repo.refs.map((ref) => pkt(`${ref.oid} ${ref.name}\n`)), FLUSH]),
          result,
        );
      }
      count('git_fetch');
      const filter = wire.find((line) => line.startsWith('filter '))?.slice(7);
      const picked = new Map();
      for (const want of wire.filter((line) => line.startsWith('want '))) {
        closure(repo, want.slice(5), filter, true, picked);
      }
      const data = pack([...picked.values()]);
      counts.git_pack_bytes = (counts.git_pack_bytes ?? 0) + data.length;
      const bands = [];
      for (let at = 0; at < data.length; at += 65_000) {
        bands.push(pkt(concat([Uint8Array.of(1), data.subarray(at, at + 65_000)])));
      }
      return new Response(
        concat([pkt('shallow-info\n'), DELIM, pkt('packfile\n'), ...bands, FLUSH]),
        result,
      );
    }
    count('unexpected');
    return new Response(null, { status: 502 });
  };
}

function cpuMilliseconds(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  assert.ok(match, 'unsupported ps CPU time format');
  return (
    (Number(match[1] ?? 0) * 86400 +
      Number(match[2] ?? 0) * 3600 +
      Number(match[3]) * 60 +
      Number(match[4])) *
    1000
  );
}

async function sample(pid) {
  let stdout;
  try {
    ({ stdout } = await runFile('ps', ['-o', 'rss=,time=', '-p', String(pid)]));
  } catch {
    return null;
  }
  const fields = stdout.trim().split(/\s+/);
  if (fields.length !== 2) return null;
  return { rssMiB: Number(fields[0]) / 1024, cpuMs: cpuMilliseconds(fields[1]) };
}

async function measure(pid, invoke) {
  const before = await sample(pid);
  assert.ok(before !== null, 'workerd process is not running');
  let peak = before.rssMiB;
  let stopped = false;
  const polling = (async () => {
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));
      if (!stopped) peak = Math.max(peak, (await sample(pid))?.rssMiB ?? 0);
    }
  })();
  const started = performance.now();
  try {
    const result = await invoke();
    const wallMs = performance.now() - started;
    stopped = true;
    await polling;
    const after = await sample(pid);
    return {
      result,
      wallMs,
      cpuMs: after === null ? null : after.cpuMs - before.cpuMs,
      baselineRssMiB: before.rssMiB,
      peakRssMiB: Math.max(peak, after?.rssMiB ?? 0),
    };
  } finally {
    stopped = true;
    await polling.catch(() => undefined);
  }
}

async function run(scriptPath, mode, tags, bytes, repetition, unbounded) {
  const repo = repository(tags, bytes);
  const counts = {};
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: '127.0.0.1',
      modules: true,
      rootPath: dirname(scriptPath),
      scriptPath: basename(scriptPath),
      compatibilityDate: '2026-10-01',
      compatibilityFlags: ['nodejs_compat'],
      outboundService: upstream(repo, counts),
      handleStructuredLogs: () => undefined,
    }),
  );
  try {
    await mf.ready;
    assert.equal(children.size, 1, 'expected one workerd process');
    const [child] = children;
    const measured = await measure(child.pid, async () => {
      try {
        const response = await mf.dispatchFetch('https://measure.test/run', {
          method: 'POST',
          body: JSON.stringify({ mode, repository: REPO, unbounded }),
        });
        return await response.json();
      } catch {
        return { outcome: 'workerd_crashed' };
      }
    });
    const subrequests = Object.entries(counts)
      .filter(([key]) => key !== 'git_pack_bytes')
      .reduce((sum, [, value]) => sum + value, 0);
    console.log(
      JSON.stringify({
        mode,
        unbounded,
        tags,
        manifestBytes: bytes,
        repetition,
        ...measured.result,
        subrequests,
        requests: counts,
        wallMs: Math.round(measured.wallMs),
        processCpuMs: measured.cpuMs,
        baselineRssMiB: Math.round(measured.baselineRssMiB * 10) / 10,
        peakRssMiB: Math.round(measured.peakRssMiB * 10) / 10,
        rssGrowthMiB: Math.round((measured.peakRssMiB - measured.baselineRssMiB) * 10) / 10,
      }),
    );
  } finally {
    await mf.dispose();
  }
}

// Old-space cap as a local stand-in for the 128 MB isolate limit; 0 leaves V8 uncapped.
const heapMiB = Number(process.env.GH_MEASURE_HEAP_MIB ?? 128);
if (heapMiB > 0) process.env.MINIFLARE_WORKERD_V8_FLAGS = `--max-old-space-size=${heapMiB}`;
const outDir = await mkdtemp(join(tmpdir(), 'pb-github-measure-'));
try {
  const scriptPath = await bundle(outDir);
  const modes = (process.env.GH_MEASURE_MODES ?? 'token,app').split(',');
  const tags = Number(process.env.GH_MEASURE_TAGS ?? 200);
  const sizes = (process.env.GH_MEASURE_BYTES ?? `${1024 * 1024},4096`).split(',').map(Number);
  const repeats = Number(process.env.GH_MEASURE_REPEATS ?? 2);
  const unbounded = process.env.GH_MEASURE_UNBOUNDED === '1';
  console.log(
    JSON.stringify({
      host: `${platform()} ${arch()}`,
      cpu: cpus()[0]?.model,
      node: process.version,
      sampleIntervalMs,
      v8OldSpaceMiB: heapMiB > 0 ? heapMiB : null,
      sources: process.env.GH_MEASURE_SOURCE_ROOT === undefined ? 'worktree' : 'override',
      note: 'process RSS and CPU of the workerd child; not an isolate heap or billed CPU measurement',
    }),
  );
  for (let repetition = 1; repetition <= repeats; repetition++) {
    for (const bytes of sizes) {
      for (const mode of modes) await run(scriptPath, mode, tags, bytes, repetition, unbounded);
    }
  }
} finally {
  channel('child_process').unsubscribe(trackChild);
  await rm(outDir, { recursive: true, force: true });
}
