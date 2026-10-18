import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchesPattern } from '../../catalogue/patterns.js';
import type { Codecs, DigestAlgorithm } from '../../platform/codec.js';
import { normalizeVersion } from '../../registry/composer/version-parser.js';
import {
  createPolicyFetch,
  type PolicyFetch,
  type UpstreamCredential,
} from '../../sources/policy-fetch.js';
import { createOutboundPolicy } from '../../sources/url-policy.js';
import {
  ComposerRootError,
  readComposerRoot,
  type ComposerRoot,
  type ComposerRootSource,
} from './root.js';
import { describeComposerV2 } from './v2-package.js';
import { readV1Index, type V1Index, type V1IndexResult } from './v1-index.js';
import { describeComposerV1 } from './v1-package.js';

const FIXTURE_DIR = new URL('../../../test-fixtures/composer-v1/', import.meta.url);
const ORIGIN = 'http://127.0.0.1:8851';
const policy = createOutboundPolicy({
  allowPrivateHosts: ['127.0.0.1:8851'],
  runtime: 'node',
  selfOrigins: [],
});
const origin = {
  probe: { secrets: [], queryParams: [] },
  importedAt: '2026-10-16T08:00:00.000Z',
};

const codecs: Pick<Codecs, 'digestTap'> = {
  digestTap<A extends DigestAlgorithm>(algs: readonly A[]) {
    const hashes = algs.map((alg) => [alg, createHash(alg)] as const);
    let settle!: { resolve(v: never): void; reject(e: unknown): void };
    const digests = new Promise<Record<A, Uint8Array>>((resolve, reject) => {
      settle = { resolve: resolve as (v: never) => void, reject };
    });
    digests.catch(() => undefined);
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const [, h] of hashes) h.update(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        settle.resolve(
          Object.fromEntries(hashes.map(([alg, h]) => [alg, new Uint8Array(h.digest())])) as never,
        );
      },
      cancel(reason) {
        settle.reject(reason);
      },
    });
    return { transform, digests };
  },
};

interface Row {
  readonly fixture: string;
  readonly assertion: string;
  readonly expected: string;
}

const rows: Row[] = readFileSync(new URL('assertions.tsv', FIXTURE_DIR), 'utf8')
  .split('\n')
  .slice(1)
  .filter((line) => line !== '')
  .map((line) => {
    const [fixture = '', assertion = '', expected = ''] = line.split('\t');
    return { fixture, assertion, expected };
  });

type Tree = Map<string, string | Uint8Array>;

function loadFixture(id: string): Tree {
  const tree: Tree = new Map();
  const walk = (dir: string, prefix: string): void => {
    const url = new URL(`${dir}/`, FIXTURE_DIR);
    if (!existsSync(url)) return;
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.body')) {
        tree.set(
          `${prefix}${entry.name.slice(0, -'.body'.length)}`,
          new Uint8Array(readFileSync(new URL(`${dir}/${entry.name}`, FIXTURE_DIR))),
        );
      }
    }
  };
  walk(id, '');
  return tree;
}

const kindOf = (path: string): string => {
  if (path.endsWith('/packages.json')) return 'root';
  if (path.includes('/_dist/')) return 'dist';
  if (path.includes('/p2/')) return 'p2';
  if (/\/p\/provider-/.test(path)) return 'provider-include';
  if (/\/p\//.test(path)) return 'provider-file';
  if (/\/(include|inc)\//.test(path)) return 'include';
  return 'other';
};

interface Server {
  readonly fetch: PolicyFetch;
  readonly requests: {
    path: string;
    raw: string;
    authorization: string | null;
    conditional: boolean;
  }[];
  readonly kinds: () => Record<string, number>;
  readonly count: (pattern: RegExp) => number;
}

interface ServerOptions {
  readonly auth?: { user: string; pass: string };
  readonly overrides?: Record<string, string>;
  readonly faults?: { prefix: string; status: number; retryAfter: string }[];
}

function serve(id: string, tree: Tree, options: ServerOptions = {}): Server {
  const requests: Server['requests'] = [];
  const faults = (options.faults ?? []).map((f) => ({ ...f, left: 1 }));
  const fetch = createPolicyFetch({
    policy,
    userAgent: 'pb-test/1',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const path = decodeURIComponent(url.pathname);
      const authorization = new Headers(init?.headers).get('authorization');
      const headers = new Headers(init?.headers);
      const conditional = headers.has('if-none-match') || headers.has('if-modified-since');
      expect(conditional).toBe(false);
      requests.push({
        path,
        raw: url.pathname,
        authorization,
        conditional,
      });
      if (options.auth !== undefined) {
        const want = `Basic ${Buffer.from(`${options.auth.user}:${options.auth.pass}`).toString('base64')}`;
        if (authorization !== want)
          return new Response('{"message":"unauthorized"}', { status: 401 });
      }
      const fault = faults.find((f) => path.startsWith(f.prefix) && f.left > 0);
      if (fault !== undefined) {
        fault.left -= 1;
        return new Response('', {
          status: fault.status,
          headers: { 'retry-after': fault.retryAfter },
        });
      }
      const rel = path.slice(`/${id}/`.length);
      const body = options.overrides?.[path] ?? tree.get(rel);
      if (!path.startsWith(`/${id}/`) || body === undefined) {
        return new Response('<html>not found</html>', { status: 404 });
      }
      return new Response(
        typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  return {
    fetch,
    requests,
    kinds() {
      const out: Record<string, number> = {};
      for (const r of requests) out[kindOf(r.path)] = (out[kindOf(r.path)] ?? 0) + 1;
      return out;
    },
    count: (pattern) => requests.filter((r) => pattern.test(r.path)).length,
  };
}

function credentialOf(auth: { user: string; pass: string }): UpstreamCredential {
  return {
    origins: [ORIGIN],
    queryParams: [],
    apply(headers, url) {
      headers.set(
        'authorization',
        `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}`,
      );
      return { headers, url };
    },
  };
}

interface Outcome {
  readonly versions: string[];
  readonly raws: Record<string, unknown>[];
  readonly skipped: Record<string, number>;
  readonly error?: string;
  readonly message?: string;
  readonly notFound?: 'definitive' | 'listed';
  readonly notModified?: boolean;
  readonly sha?: string;
}

interface Run {
  readonly server: Server;
  readonly root?: ComposerRoot;
  readonly rootError?: ComposerRootError;
  readonly index?: V1Index;
  readonly outcomes: Map<string, Outcome>;
  readonly status?: V1IndexResult['status'];
}

const AUTH = { user: 'fx-user', pass: 'pw-0123456789' };

function sourceOf(
  id: string,
  auth?: { user: string; pass: string },
  url?: string,
): ComposerRootSource {
  return {
    url: url ?? `${ORIGIN}/${id}`,
    policy,
    allowedOrigins: [],
    ...(auth === undefined ? {} : { credential: credentialOf(auth) }),
  };
}

async function describeAll(
  server: Server,
  source: ComposerRootSource,
  root: ComposerRoot,
  index: V1Index | undefined,
  names: readonly string[],
  previous: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, Outcome>> {
  const outcomes = new Map<string, Outcome>();
  for (const name of names) {
    try {
      const prev = previous.get(name);
      const result = await describeComposerV1(server.fetch, name, {
        source,
        root,
        ...(index === undefined ? {} : { index }),
        selection: { packages: names, patterns: [], expandPatterns: false },
        origin,
        codecs,
        ...(prev === undefined ? {} : { previousSha256: prev }),
      });
      if (result.kind === 'not_modified') {
        outcomes.set(name, { versions: [], raws: [], skipped: {}, notModified: true });
      } else if (result.kind === 'not_found') {
        outcomes.set(name, {
          versions: [],
          raws: [],
          skipped: {},
          notFound: result.definitive ? 'definitive' : 'listed',
        });
      } else if (result.kind === 'found') {
        const members = [];
        for await (const m of result.description.members) members.push(m);
        outcomes.set(name, {
          versions: members.map((m) => m.version),
          raws: members.map((m) => JSON.parse(m.raw) as Record<string, unknown>),
          skipped: { ...result.skipped } as Record<string, number>,
          sha: result.description.snapshot.id.replace('sha256:', ''),
        });
      }
    } catch (error) {
      outcomes.set(name, {
        versions: [],
        raws: [],
        skipped: {},
        error: error instanceof Error ? error.name + ':' + (error as { code?: string }).code : 'x',
        message: error instanceof Error ? error.message : '',
      });
    }
  }
  return outcomes;
}

function trackedNames(fixture: string): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    const m = /^adapter ingested versions of (.+)$/.exec(row.assertion);
    if (row.fixture === fixture && m?.[1] !== undefined) names.add(m[1]);
  }
  return [...names];
}

const FIXTURE_IDS = [...new Set(rows.map((r) => r.fixture))].filter((id) => /^f\d\d-/.test(id));

const sorted = (values: readonly string[]): string[] => [...values].sort();

interface Verdict {
  readonly kind: 'value' | 'excluded';
  readonly category?: 'cli' | 'fixture-server' | 'dist' | 'render' | 'transport';
  readonly reason?: string;
  readonly actual?: unknown;
  readonly expected?: unknown;
  readonly dropped?: readonly string[];
}

const value = (actual: unknown, extra: Partial<Verdict> = {}): Verdict => ({
  kind: 'value',
  actual,
  ...extra,
});
const excluded = (category: NonNullable<Verdict['category']>, reason?: string): Verdict => ({
  kind: 'excluded',
  category,
  ...(reason === undefined ? {} : { reason }),
});

const memo = new Map<string, Promise<unknown>>();
function once<T>(key: string, make: () => Promise<T>): Promise<T> {
  let hit = memo.get(key) as Promise<T> | undefined;
  if (hit === undefined) {
    hit = make();
    memo.set(key, hit);
  }
  return hit;
}

interface Sync extends Run {
  readonly pollStatus?: V1IndexResult['status'];
  readonly pollError?: ComposerRootError;
  readonly pollKinds: Record<string, number>;
  readonly coldKinds: Record<string, number>;
  readonly describeKinds: Record<string, number>;
}

async function sync(id: string, wrongAuth = false): Promise<Sync> {
  const tree = loadFixture(id);
  const options: ServerOptions = {
    ...(id.startsWith('f21') ? { auth: AUTH } : {}),
    ...(id.startsWith('f24')
      ? {
          overrides: Object.fromEntries(
            [...tree.entries()]
              .filter(([p]) => p.startsWith('p/fx/bad$'))
              .map(([p, body]) => [
                `/${id}/${p}`,
                (typeof body === 'string' ? body : new TextDecoder().decode(body)).replace(
                  '1.0.0',
                  '1.0.1',
                ),
              ]),
          ),
        }
      : {}),
    ...(id.startsWith('f26')
      ? { faults: [{ prefix: `/${id}/p/fx/lib`, status: 429, retryAfter: '1' }] }
      : {}),
  };
  const server = serve(id, tree, options);
  const creds = id.startsWith('f21')
    ? { ...AUTH, pass: wrongAuth ? 'wrong' : AUTH.pass }
    : undefined;
  const source = sourceOf(
    id,
    creds,
    id.startsWith('f32') ? `${ORIGIN}/${id}/packages.json` : undefined,
  );
  const kindsSince = (mark: number): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const r of server.requests.slice(mark))
      out[kindOf(r.path)] = (out[kindOf(r.path)] ?? 0) + 1;
    return out;
  };
  let result: V1IndexResult | undefined;
  let rootError: ComposerRootError | undefined;
  try {
    result = await readV1Index(server.fetch, { source, codecs });
  } catch (error) {
    if (!(error instanceof ComposerRootError)) throw error;
    rootError = error;
  }
  if (result === undefined) {
    return {
      server,
      outcomes: new Map(),
      rootError,
      pollKinds: {},
      coldKinds: kindsSince(0),
      describeKinds: {},
    } as Sync;
  }
  const index = result.status === 'updated' ? result.index : undefined;
  const mark = server.requests.length;
  const outcomes = await describeAll(server, source, result.root, index, trackedNames(id));
  const describeKinds = kindsSince(mark);
  const coldKinds = kindsSince(0);
  const pollMark = server.requests.length;
  let pollStatus: V1IndexResult['status'] | undefined;
  let pollError: ComposerRootError | undefined;
  try {
    const poll = await readV1Index(
      server.fetch,
      { source, codecs },
      index === undefined ? undefined : { rootSha256: index.rootSha256, complete: index.complete },
    );
    pollStatus = poll.status;
  } catch (error) {
    if (!(error instanceof ComposerRootError)) throw error;
    pollError = error;
  }
  return {
    server,
    root: result.root,
    ...(index === undefined ? {} : { index }),
    outcomes,
    status: result.status,
    ...(pollStatus === undefined ? {} : { pollStatus }),
    ...(pollError === undefined ? {} : { pollError }),
    pollKinds: kindsSince(pollMark),
    coldKinds,
    describeKinds,
  } as Sync;
}

async function v2(id: string) {
  const server = serve(id, loadFixture(id));
  const source = sourceOf(id);
  let root: ComposerRoot | undefined;
  let syncExit: 0 | 'non-zero' = 0;
  try {
    root = await readComposerRoot(server.fetch, source);
  } catch {
    syncExit = 'non-zero';
  }
  const versions = new Map<string, string[]>();
  let packageErrors = 0;
  if (root !== undefined)
    for (const name of trackedNames(id)) {
      const list: string[] = [];
      try {
        const result = await describeComposerV2(server.fetch, { root, allowedOrigins: [] }, name, {
          path: 'job',
          dev: true,
          probe: origin.probe,
          clock: { now: () => new Date('2026-10-16T08:00:00.000Z') },
        });
        if (result.kind === 'not_found') packageErrors += 1;
        if (result.kind === 'found')
          for await (const m of result.description.members) list.push(m.version);
      } catch {
        packageErrors += 1;
      }
      versions.set(name, list);
    }
  let pollExit: 0 | 'non-zero' = 0;
  try {
    await readComposerRoot(server.fetch, source);
  } catch {
    pollExit = 'non-zero';
  }
  return { server, root, versions, syncExit, pollExit, packageErrors };
}

const parseExpected = (text: string): unknown => {
  if (text === 'undefined') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const CLI =
  /^(composer |mirror |Composer |composer\.lock|require against|locked version)|(Composer requests|used by Composer)/;
const FIXTURE_SERVER = /^(origin |anonymous request)/;
const DIST_ROW =
  /^(source-only versions|version with dist and source|tar dist|missing upstream shasum|wrong upstream shasum|eagerLatest|default broker User-Agent|with a Composer User-Agent)/;

function pick(kinds: Record<string, number>, keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.map((k) => [k, kinds[k] ?? 0]));
}

async function judge(row: Row): Promise<Verdict> {
  const { fixture: f, assertion: a } = row;
  if (f === 'norm') {
    const input = /^normalize\((.*)\) matches/.exec(a)?.[1] ?? '';
    return value(normalizeVersion(input));
  }
  if (f.startsWith('cd-')) return cdVerdict(row);
  if (a === 'mirror metadata has no notification-url and no uid')
    return excluded('render', 'Requires rendered mirror metadata; ingest retains upstream fields.');
  if (a === 'include path contains a literal $ hash separator and carries a sha1')
    return excluded(
      'fixture-server',
      'Checks a literal fixture property rather than product behavior.',
    );
  if (a === 'adapter received gzip-encoded metadata and ingested it')
    return excluded(
      'transport',
      'The in-memory fetch serves decoded bodies and does not exercise gzip transport.',
    );
  if (CLI.test(a)) return excluded('cli');
  if (FIXTURE_SERVER.test(a)) return excluded('fixture-server');
  if (DIST_ROW.test(a)) return excluded('dist');
  if (a === 'adapter mode detected') {
    return value(
      await once(`mode:${f}`, async () => {
        const server = serve(f, loadFixture(f));
        const url = f.startsWith('f32') ? `${ORIGIN}/${f}/packages.json` : undefined;
        const root = await readComposerRoot(
          server.fetch,
          sourceOf(f, f.startsWith('f21') ? AUTH : undefined, url),
        );
        return root.mode;
      }),
    );
  }
  const isV2 = f.startsWith('f27') || f.startsWith('f31');
  if (isV2) return v2Verdict(row);
  const r = await once(`sync:${f}`, () => sync(f));
  let m: RegExpExecArray | null;
  if ((m = /^adapter ingested versions of (.+)$/.exec(a))) {
    const outcome = r.outcomes.get(m[1] ?? '');
    return value(sorted(outcome?.versions ?? []), {
      expected: sorted(parseExpected(row.expected) as string[]),
    });
  }
  if ((m = /^adapter ingested nothing for (.+)$/.exec(a)))
    return value(r.outcomes.get(m[1] ?? '')?.versions ?? []);
  switch (a) {
    case 'adapter sync exit':
      return value(r.rootError === undefined ? 0 : 'non-zero');
    case 'adapter poll exit':
      return value(r.rootError === undefined && r.pollError === undefined ? 0 : 'non-zero');
    case 'adapter per-package errors':
      return value(
        [...r.outcomes.values()].filter((o) => o.error !== undefined || o.notFound === 'listed')
          .length,
      );
    case 'adapter names the unsupported layout in its error':
      return value(r.rootError?.code === 'unsupported');
    case 'adapter reports the 404 on packages.json':
      return value(r.rootError?.code === 'http_status' && r.rootError.status === 404);
    case 'adapter requests the include with $ encoded as %24 like Composer': {
      const includes = r.server.requests.filter((q) => kindOf(q.path) === 'include');
      expect(includes.length).toBeGreaterThan(0);
      return value(includes.every((q) => q.raw.includes('%24')));
    }
    case 'adapter ignores available-packages outside metadata-url repositories':
      return value(r.root?.availablePackages);
    case 'adapter makes no /p2/ request against a v1 root':
      return value(r.coldKinds.p2 ?? 0);
    case 'providers-url wins over includes: adapter requests no include':
      return value(r.coldKinds.include ?? 0);
    case 'adapter does not request lazy files for names shadowed by inline packages':
      return value({
        lib: r.server.count(/\/p\/fx\/lib\.json$/),
        inline: r.server.count(/\/p\/fx\/inline\.json$/),
        app: r.server.count(/\/p\/fx\/app\.json$/),
      });
    case 'adapter never requests notify, notify-batch, search, providers-api, list or mirror URLs':
      return value(r.server.count(/\/(notify|search\.json|api\/|list\.json|mirror\/|downloads\/)/));
    case 'adapter surfaces upstream warning and info messages as events with their versions constraint':
      return value(
        (['warning', 'info'] as const).every((type) =>
          (r.root?.messages ?? []).some((msg) => msg.type === type && msg.versions !== undefined),
        ),
      );
    case 'versions of fx/two listed inside the fx/one file are attributed to neither':
      return value({
        one: r.outcomes.get('fx/one')?.versions,
        two: r.outcomes.get('fx/two')?.versions,
      });
    case 'every stored version of fx/one has name fx/one':
      return value((r.outcomes.get('fx/one')?.raws ?? []).every((raw) => raw.name === 'fx/one'));
    case 'default-branch and branch-alias survive the rewrite': {
      const raw = r.outcomes.get('fx/shapes')?.raws.find((v) => v.version === 'dev-main');
      const extra = raw?.extra as { 'branch-alias'?: Record<string, string> } | undefined;
      return value([raw?.['default-branch'], extra?.['branch-alias']?.['dev-main']]);
    }
    case 'duplicate version across include files is stored once':
    case 'duplicate version in one provider file is stored once':
      return value(r.outcomes.get('fx/dup')?.versions.length);
    case 'no validators on the origin: poll gets 200 on packages.json and no 304':
      return value({
        notModified: r.server.requests.filter((q) => q.conditional).length,
        exit: r.pollError === undefined ? 0 : 'non-zero',
      });
    case 'poll with validators: packages.json answers 304, include served from cache':
      return value({
        exit: r.pollError === undefined ? 0 : 'non-zero',
        notModified: r.server.requests.filter((q) => q.conditional).length,
        include: r.pollKinds.include ?? 0,
      });
    case 'wrong credentials fail the sync with a non-zero exit and ingest nothing': {
      const bad = await once('sync:f21-wrong', () => sync(f, true));
      return value([
        bad.rootError === undefined ? 0 : 'non-zero',
        bad.outcomes.get('fx/lib')?.versions ?? [],
      ]);
    }
    case 'with credentials every upstream request is authenticated':
      return value(r.server.requests.filter((q) => q.authorization === null).length);
    case 'missing provider file: listing re-fetched once, then recorded as a package error':
      return value(
        r.outcomes.get('fx/broken')?.notFound === 'listed' && r.describeKinds.root === 1,
      );
    case 'corrupt provider file: 3 attempts like Composer, then rejected and not ingested':
      return value({
        attempts: r.server.count(/\/p\/fx\/bad\$/),
        ingested: r.outcomes.get('fx/bad')?.versions ?? [],
      });
    case 'the healthy package is still ingested':
      return value(r.outcomes.get('fx/lib')?.versions.length);
    case 'adapter honours Retry-After once and ingests':
      return value({
        retry429: r.server.count(/\/p\/fx\/lib/) - 1,
        versions: r.outcomes.get('fx/lib')?.versions.length,
      });
    case 'adapter logs a hash-mismatch event per failed algorithm and still ingests (Composer verifies neither sha1 nor sha256 of includes)':
      return value(r.index?.complete === true);
  }
  if (a.startsWith('adapter cold sync')) {
    const keys = Object.keys(parseExpected(row.expected) as Record<string, number>);
    return value(pick(r.coldKinds, keys));
  }
  if (a.startsWith('adapter changes does not crash')) {
    return value(r.root?.metadataChangesUrl === undefined ? 0 : 1);
  }
  if (a.startsWith('repository url ending in packages.json')) {
    return excluded(
      'fixture-server',
      'The fixture has no include, so resolving includes against the base directory is not exercised.',
    );
  }
  throw new Error(`unclassified row: ${f} ${a}`);
}

async function v2Verdict(row: Row): Promise<Verdict> {
  const { fixture: f, assertion: a } = row;
  const r = await once(`v2:${f}`, () => v2(f));
  let m: RegExpExecArray | null;
  if ((m = /^adapter ingested versions of (.+)$/.exec(a))) {
    return value(sorted(r.versions.get(m[1] ?? '') ?? []), {
      expected: sorted(parseExpected(row.expected) as string[]),
    });
  }
  if (a === 'adapter sync exit') return value(r.syncExit);
  if (a === 'adapter poll exit') return value(r.pollExit);
  if (a === 'adapter per-package errors') return value(r.packageErrors);
  if (a.startsWith('adapter changes does not crash')) {
    return value(r.root?.metadataChangesUrl === undefined ? 0 : 1);
  }
  if (a === 'metadata-url wins: adapter requests p2 only') {
    return value({
      p2Positive: (r.server.kinds().p2 ?? 0) > 0,
      providerFile: r.server.kinds()['provider-file'] ?? 0,
    });
  }
  if (a === 'no p2 request for the name found in inline packages') {
    return value(r.server.count(/\/p2\/fx\/inline/));
  }
  throw new Error(`unclassified row: ${f} ${a}`);
}

const sha = (alg: 'sha1' | 'sha256', text: string): string =>
  createHash(alg).update(text).digest('hex');

function versionList(name: string, versions: readonly string[]): Record<string, unknown>[] {
  return versions.map((version, i) => ({
    name,
    version,
    version_normalized: normalizeVersion(version),
    time: '2024-01-02T03:04:05+00:00',
    type: 'library',
    dist: {
      type: 'zip',
      url: `${ORIGIN}/dist/${name}/${version}.zip`,
      reference: sha('sha1', `${name}@${version}`),
      shasum: '',
    },
    uid: 1000 + i,
  }));
}

function inlineOf(
  list: readonly Record<string, unknown>[],
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const v of list) (out[v.name as string] ??= {})[v.version as string] = v;
  return out;
}

const bodyOf = (list: readonly Record<string, unknown>[]): string =>
  JSON.stringify({ packages: inlineOf(list) });

interface CdStep {
  readonly name: string;
  readonly mutate?: () => void;
  readonly patterns?: readonly string[];
  readonly command?: 'sync' | 'poll';
}

interface CdResult {
  readonly counts: Record<string, number>;
  readonly outcomes: Map<string, Outcome>;
  readonly mode: string;
}

async function cdFlow(
  id: string,
  names: readonly string[],
  tree: Tree,
  steps: readonly CdStep[],
): Promise<Map<string, CdResult>> {
  const server = serve(id, tree);
  const source = sourceOf(id);
  const out = new Map<string, CdResult>();
  const shas = new Map<string, string>();
  let previous: { rootSha256: string; complete: boolean } | undefined;
  let index: V1Index | undefined;
  for (const step of steps) {
    step.mutate?.();
    const mark = server.requests.length;
    const result = await readV1Index(server.fetch, { source, codecs }, previous);
    if (result.status === 'updated') index = result.index;
    previous =
      index === undefined ? undefined : { rootSha256: index.rootSha256, complete: index.complete };
    const lazy = result.root.mode === 'v1-lazy';
    const tracked = new Set(names);
    for (const pattern of step.patterns ?? []) {
      for (const key of index?.entries.keys() ?? [])
        if (matchesPattern(pattern, key)) tracked.add(key);
    }
    const outcomes =
      result.status === 'not_modified' && !lazy
        ? new Map<string, Outcome>()
        : await describeAll(server, source, result.root, index, [...tracked], shas);
    for (const [name, outcome] of outcomes)
      if (outcome.sha !== undefined) shas.set(name, outcome.sha);
    const kinds: Record<string, number> = {};
    for (const r of server.requests.slice(mark))
      kinds[kindOf(r.path)] = (kinds[kindOf(r.path)] ?? 0) + 1;
    const changed = [...outcomes.values()].filter((o) => o.sha !== undefined).length;
    out.set(step.name, {
      counts: {
        ...kinds,
        changed,
        notModified: server.requests.slice(mark).filter((q) => q.conditional).length,
      },
      outcomes,
      mode: result.root.mode,
    });
  }
  return out;
}

function cdRun(): Promise<Map<string, CdResult>> {
  return once('cd', async () => {
    const all = new Map<string, CdResult>();
    const add = (layout: string, steps: Map<string, CdResult>): void => {
      for (const [name, result] of steps) all.set(`${layout}: ${name}`, result);
    };

    {
      const id = 'cd-providers';
      const tree: Tree = new Map();
      const lib = versionList('fx/lib', ['1.0.0', '1.1.0']);
      const app = versionList('fx/app', ['1.0.0']);
      const lib12 = versionList('fx/lib', ['1.2.0']);
      const other = versionList('fx/unrelated', ['1.0.0']);
      const write = (
        libs: readonly Record<string, unknown>[],
        apps: readonly Record<string, unknown>[] | null,
        extra: Record<string, readonly Record<string, unknown>[]> = {},
        rootExtra: Record<string, unknown> = {},
        libKey = 'fx/lib',
      ): void => {
        tree.clear();
        const listing: Record<string, { sha256: string }> = {};
        const lists = { [libKey]: libs, ...(apps === null ? {} : { 'fx/app': apps }), ...extra };
        for (const [name, list] of Object.entries(lists)) {
          const body = bodyOf(list);
          const hash = sha('sha256', body);
          tree.set(`p/${name}$${hash}.json`, body);
          listing[name] = { sha256: hash };
        }
        const includeBody = JSON.stringify({ providers: listing });
        const includeHash = sha('sha256', includeBody);
        tree.set(`p/provider-${includeHash}.json`, includeBody);
        tree.set(
          'packages.json',
          JSON.stringify({
            packages: [],
            'providers-url': `/${id}/p/%package%$%hash%.json`,
            'provider-includes': { 'p/provider-%hash%.json': { sha256: includeHash } },
            ...rootExtra,
          }),
        );
      };
      write(lib, app);
      add(
        'providers',
        await cdFlow(id, ['fx/lib', 'fx/app'], tree, [
          { name: 'cold sync' },
          { name: 'poll, nothing changed' },
          {
            name: 'packages.json changed only (new warning key)',
            mutate: () => write(lib, app, {}, { warning: 'x' }),
          },
          {
            name: 'provider-includes hash changed, per-package hashes unchanged',
            mutate: () => write(lib, app, { 'fx/unrelated': other }),
          },
          {
            name: 'one package hash changed (fx/lib 1.2.0)',
            mutate: () => write([...lib, ...lib12], app, { 'fx/unrelated': other }),
          },
          {
            name: 'package removed from the index',
            mutate: () => write([...lib, ...lib12], null, { 'fx/unrelated': other }),
          },
          {
            name: 'package renamed (fx/lib -> fx/lib-new), pattern fx/* selects it',
            patterns: ['fx/*'],
            mutate: () =>
              write(
                versionList('fx/lib-new', ['1.0.0']),
                null,
                { 'fx/unrelated': other },
                {},
                'fx/lib-new',
              ),
          },
        ]),
      );
    }

    for (const [id, validators] of [
      ['cd-includes', false],
      ['cd-includes-validators', true],
    ] as const) {
      void validators;
      const tree: Tree = new Map();
      const lib = versionList('fx/lib', ['1.0.0', '1.1.0']);
      const lib12 = versionList('fx/lib', ['1.2.0']);
      const write = (
        list: readonly Record<string, unknown>[],
        rootExtra: Record<string, unknown> = {},
      ): void => {
        tree.clear();
        const body = bodyOf(list);
        const hash = sha('sha1', body);
        tree.set(`include/all$${hash}.json`, body);
        tree.set(
          'packages.json',
          JSON.stringify({
            packages: [],
            includes: { [`include/all$${hash}.json`]: { sha1: hash } },
            ...rootExtra,
          }),
        );
      };
      write(lib);
      const steps: CdStep[] =
        id === 'cd-includes'
          ? [
              { name: 'cold sync' },
              { name: 'poll, nothing changed (sha1 matches the cached include)' },
              { name: 'packages.json changed only', mutate: () => write(lib, { warning: 'x' }) },
              {
                name: 'include content changed (new sha1 and file name)',
                mutate: () => write([...lib, ...lib12]),
              },
            ]
          : [{ name: 'cold sync' }, { name: 'poll, nothing changed: packages.json answers 304' }];
      const result = await cdFlow(id, ['fx/lib'], tree, steps);
      add(id === 'cd-includes' ? 'includes' : 'includes with validators', result);
    }

    for (const id of ['cd-lazy', 'cd-lazy-validators']) {
      const tree: Tree = new Map();
      const lib = versionList('fx/lib', ['1.0.0', '1.1.0']);
      const app = versionList('fx/app', ['1.0.0']);
      const lib12 = versionList('fx/lib', ['1.2.0']);
      const write = (libs: readonly Record<string, unknown>[]): void => {
        tree.set('p/fx/lib.json', bodyOf(libs));
        tree.set('p/fx/app.json', bodyOf(app));
        tree.set(
          'packages.json',
          JSON.stringify({ packages: [], 'providers-lazy-url': `/${id}/p/%package%.json` }),
        );
      };
      write(lib);
      const steps: CdStep[] =
        id === 'cd-lazy'
          ? [
              { name: 'cold sync' },
              {
                name: 'poll without validators: one request per tracked package, nothing re-ingested',
              },
              { name: 'one package changed', mutate: () => write([...lib, ...lib12]) },
            ]
          : [
              { name: 'cold sync' },
              { name: 'poll: every lazy file answers 304 (If-Modified-Since)' },
            ];
      add(
        id === 'cd-lazy' ? 'lazy' : 'lazy with validators',
        await cdFlow(id, ['fx/lib', 'fx/app'], tree, steps),
      );
    }
    return all;
  });
}

async function cdVerdict(row: Row): Promise<Verdict> {
  const results = await cdRun();
  const result = results.get(row.assertion);
  const expected = parseExpected(row.expected) as Record<string, number> | unknown;
  if (result === undefined) {
    if (row.assertion.startsWith('providers: changed package ingested, dist'))
      return excluded('dist');
    if (
      row.assertion === 'providers: removed package is marked missing, nothing requested for it'
    ) {
      const step = results.get('providers: package removed from the index');
      return value(step?.outcomes.get('fx/app')?.notFound === 'definitive');
    }
    if (
      row.assertion ===
      'providers: old name missing, new name ingested through the expanded pattern'
    ) {
      const step = results.get(
        'providers: package renamed (fx/lib -> fx/lib-new), pattern fx/* selects it',
      );
      return value([
        step?.outcomes.get('fx/lib')?.notFound === 'definitive',
        step?.outcomes.get('fx/lib-new')?.versions.length,
      ]);
    }
    throw new Error(`unclassified row: ${row.assertion}`);
  }
  const wanted = expected as Record<string, number>;
  const dropped = ['dist'].filter((k) => k in wanted);
  const keys = Object.keys(wanted).filter((k) => !dropped.includes(k));
  return value(pick(result.counts, keys), {
    expected: Object.fromEntries(keys.map((k) => [k, wanted[k]])),
    dropped,
  });
}

const ROOT_REREAD =
  'a v1-includes root is read twice (root, then streamed for its inline members), so cold root requests are 2';
const CHANGED_ROOT =
  'a changed root refetches every include (design 4.3), including after a warning-only change';
const NO_CONDITIONAL =
  'v1 roots and lazy files are fetched unconditionally; "unchanged" is decided by the root hash, never by a 304';
const INCLUDE_HASH =
  'an include whose body does not match its listed hash fails the pass (G1 safer rule)';
const DUPLICATE_NAME =
  'conflicting member hashes across include documents fail the pass (reason duplicate); identical listings are accepted';
const LEGACY =
  'known bug, tracked in T709: a legacy root (top-level name => {versions}) is not read: the index lists no names';
const NO_RETRY =
  'known gap, tracked in T709 (Retry-After on v1 429): describeComposerV1 does not retry or sleep on 429; the status error propagates to the caller';
const V2_PARTIAL =
  'known bug, tracked in T709: inline partial packages of a metadata-url root are not read by the v2 path';
const NO_PROOF =
  'an incomplete or empty index yields no definitive absence, so an unlisted name is a per-package error';
const DIST_FAULT =
  'the wrong upstream shasum is a dist-level fault found when the dist is stored, not when versions are described';
const NO_RELIST =
  'describeComposerV1 does not re-read the listing; a listed-but-missing file is reported to the caller';

const PINNED: Readonly<Record<string, { actual: unknown; why: string }>> = {
  'f03-satis-includes|adapter cold sync requests: 1 root, 1 include, no provider or p2 requests': {
    actual: { root: 2, include: 1, 'provider-file': 0, p2: 0 },
    why: ROOT_REREAD,
  },
  'f15-dist-shapes|adapter per-package errors': { actual: 0, why: DIST_FAULT },
  'f05-includes-hash-mismatch|adapter ingested versions of fx/lib': {
    actual: [],
    why: INCLUDE_HASH,
  },
  'f05-includes-hash-mismatch|adapter ingested versions of fx/app': {
    actual: [],
    why: INCLUDE_HASH,
  },
  'f05-includes-hash-mismatch|adapter logs a hash-mismatch event per failed algorithm and still ingests (Composer verifies neither sha1 nor sha256 of includes)':
    { actual: false, why: INCLUDE_HASH },
  'f05-includes-hash-mismatch|adapter per-package errors': { actual: 2, why: NO_PROOF },
  'f08-providers-includes-multi|adapter per-package errors': { actual: 3, why: NO_PROOF },
  'f17-duplicate-versions|adapter per-package errors': { actual: 1, why: NO_PROOF },
  'f33-legacy-format|adapter per-package errors': { actual: 2, why: LEGACY },
  'f08-providers-includes-multi|adapter ingested versions of fx/lib': {
    actual: [],
    why: DUPLICATE_NAME,
  },
  'f08-providers-includes-multi|adapter ingested versions of fx/app': {
    actual: [],
    why: DUPLICATE_NAME,
  },
  'f08-providers-includes-multi|adapter ingested versions of fx/extra': {
    actual: [],
    why: DUPLICATE_NAME,
  },
  'f08-providers-includes-multi|adapter cold sync requests: 3 provider-includes, 3 provider files':
    {
      actual: { 'provider-include': 6, 'provider-file': 0 },
      why: DUPLICATE_NAME,
    },
  'f17-duplicate-versions|adapter ingested versions of fx/dup': { actual: [], why: DUPLICATE_NAME },
  'f17-duplicate-versions|duplicate version across include files is stored once': {
    actual: 0,
    why: DUPLICATE_NAME,
  },
  'f24-stale-and-corrupt-hash|missing provider file: listing re-fetched once, then recorded as a package error':
    { actual: false, why: NO_RELIST },
  'f26-429-once|adapter ingested versions of fx/lib': { actual: [], why: NO_RETRY },
  'f26-429-once|adapter per-package errors': { actual: 1, why: NO_RETRY },
  'f26-429-once|adapter honours Retry-After once and ingests': {
    actual: { retry429: 0, versions: 0 },
    why: NO_RETRY,
  },
  'f31-v2-partial|adapter per-package errors': { actual: 1, why: V2_PARTIAL },
  'f31-v2-partial|adapter ingested versions of fx/inline': { actual: [], why: V2_PARTIAL },
  'f31-v2-partial|no p2 request for the name found in inline packages': {
    actual: 2,
    why: V2_PARTIAL,
  },
  'f33-legacy-format|adapter ingested versions of fx/lib': { actual: [], why: LEGACY },
  'f33-legacy-format|adapter ingested versions of fx/app': { actual: [], why: LEGACY },
  'f34-includes-validators|poll with validators: packages.json answers 304, include served from cache':
    {
      actual: { exit: 0, notModified: 0, include: 0 },
      why: NO_CONDITIONAL,
    },
  'cd-providers|providers: packages.json changed only (new warning key)': {
    actual: { root: 1, 'provider-include': 1, 'provider-file': 0, changed: 0 },
    why: CHANGED_ROOT,
  },
  'cd-includes|includes: cold sync': {
    actual: { root: 2, include: 1, changed: 1 },
    why: ROOT_REREAD,
  },
  'cd-includes|includes: packages.json changed only': {
    actual: { root: 2, include: 1, changed: 0 },
    why: `${ROOT_REREAD}; ${CHANGED_ROOT}`,
  },
  'cd-includes|includes: include content changed (new sha1 and file name)': {
    actual: { root: 2, include: 1, changed: 1 },
    why: ROOT_REREAD,
  },
  'cd-includes-validators|includes with validators: cold sync': {
    actual: { root: 2, include: 1, notModified: 0 },
    why: ROOT_REREAD,
  },
  'cd-includes-validators|includes with validators: poll, nothing changed: packages.json answers 304':
    {
      actual: { root: 1, include: 0, notModified: 0, changed: 0 },
      why: NO_CONDITIONAL,
    },
  'cd-lazy-validators|lazy with validators: poll: every lazy file answers 304 (If-Modified-Since)':
    {
      actual: { root: 1, 'provider-file': 2, notModified: 0, changed: 0 },
      why: NO_CONDITIONAL,
    },
};

const tally: Record<string, number> = {};
const bump = (key: string): void => {
  tally[key] = (tally[key] ?? 0) + 1;
};

describe('v1 conformance corpus', () => {
  it('holds the 34 fixtures and 513 recorded assertion rows', () => {
    expect(FIXTURE_IDS).toHaveLength(34);
    expect(rows).toHaveLength(513);
  });

  describe.each(rows.map((r, i) => ({ ...r, i })))('$fixture', (row) => {
    it(`${row.assertion} [${row.i}]`, async () => {
      const verdict = await judge(row);
      if (verdict.kind === 'excluded') {
        bump(`excluded:${verdict.category}`);
        return;
      }
      const expected = verdict.expected ?? parseExpected(row.expected);
      const pin = PINNED[`${row.fixture}|${row.assertion}`];
      if (pin === undefined) {
        expect(verdict.actual).toEqual(expected);
        bump('pass');
      } else {
        expect(verdict.actual).not.toEqual(expected);
        expect(verdict.actual).toEqual(pin.actual);
        bump('pinned');
      }
      if (verdict.dropped !== undefined && verdict.dropped.length > 0) bump('partial');
    });
  });

  it('accounts for every row', () => {
    expect(tally).toEqual({
      pass: 277,
      pinned: 32,
      partial: 6,
      'excluded:cli': 186,
      'excluded:fixture-server': 5,
      'excluded:dist': 11,
      'excluded:render': 1,
      'excluded:transport': 1,
    });
  });
});

describe('v1 conformance negative cases', () => {
  it.each(['f08-providers-includes-multi', 'f17-duplicate-versions'])(
    '%s accepts identical listings and rejects the original conflicting fixture',
    async (id) => {
      const original = await sync(id);
      expect(original.index?.complete).toBe(false);
      expect(original.index?.reason).toBe('duplicate');
      expect(original.index?.entries.size).toBe(0);
      const tree = loadFixture(id);
      const decode = (body: string | Uint8Array | undefined): string =>
        typeof body === 'string' ? body : new TextDecoder().decode(body);
      const root = JSON.parse(decode(tree.get('packages.json')));
      const providers = id.startsWith('f08');
      const section = providers ? 'providers' : 'packages';
      const listings = root[providers ? 'provider-includes' : 'includes'];
      let first: unknown;
      for (const [path, hashes] of Object.entries(listings)) {
        const algorithm = providers ? 'sha256' : 'sha1';
        const hash = (hashes as Record<string, string>)[algorithm] as string;
        const resolved = path.replace('%hash%', hash);
        const doc = JSON.parse(decode(tree.get(resolved)));
        const name = providers ? 'fx/lib' : 'fx/dup';
        if (doc[section][name] !== undefined) {
          first ??= doc[section][name];
          doc[section][name] = first;
        }
        const body = JSON.stringify(doc);
        const updatedHash = sha(algorithm, body);
        delete listings[path];
        listings[path.replace(hash, updatedHash)] = { [algorithm]: updatedHash };
        tree.set(resolved.replace(hash, updatedHash), body);
      }
      tree.set('packages.json', JSON.stringify(root));
      const server = serve(id, tree);
      const source = sourceOf(id);
      const result = await readV1Index(server.fetch, { source, codecs });
      expect(result.status).toBe('updated');
      if (result.status !== 'updated') throw new Error('expected updated');
      expect(result.index.complete).toBe(true);
      expect(result.index.entries.size).toBe(providers ? 3 : 1);
      const outcomes = await describeAll(
        server,
        source,
        result.root,
        result.index,
        trackedNames(id),
      );
      expect(outcomes.get(providers ? 'fx/lib' : 'fx/dup')?.versions).toEqual(
        providers ? ['1.0.0', '1.1.0', 'dev-main'] : ['1.0.0', '1.1.0'],
      );
    },
  );

  it('keeps upstream bodies and credentials out of root and package errors', async () => {
    const wrong = await sync('f21-auth', true);
    expect(wrong.rootError?.code).toBe('http_status');
    expect(wrong.rootError?.message).not.toContain('unauthorized');
    expect(wrong.rootError?.message).not.toContain('wrong');
    expect(wrong.rootError?.message).not.toContain(AUTH.user);
    const corrupt = await sync('f24-stale-and-corrupt-hash');
    const bad = corrupt.outcomes.get('fx/bad');
    expect(bad?.error).toBe('ComposerV1PackageError:hash');
    expect(bad?.message).toBe('composer v1 package hash');
    const limited = await sync('f26-429-once');
    expect(limited.outcomes.get('fx/lib')?.message).toBe('composer v1 package status (429)');
  });

  it('drops objects named for another package from a provider file', async () => {
    const r = await sync('f12-other-names-in-file');
    expect(r.outcomes.get('fx/one')?.skipped).toEqual({ foreign_name: 2 });
    expect(r.outcomes.get('fx/one')?.raws.map((v) => v.name)).toEqual(['fx/one']);
    expect(r.outcomes.get('fx/ghost')?.notFound).toBe('definitive');
  });

  it('refuses a v2 root and an inline providers map without providers-url', async () => {
    expect((await sync('f09-providers-inline-no-url')).rootError?.code).toBe('unsupported');
    expect((await sync('f27-mixed-v2-v1')).rootError?.code).toBe('unsupported');
    expect((await sync('f25-no-root')).rootError?.code).toBe('http_status');
  });
});
