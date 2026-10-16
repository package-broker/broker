import type { Codecs } from '../../platform/codec.js';
import {
  UpstreamError,
  type PolicyFetch,
  type UpstreamCredential,
  type UpstreamResponse,
} from '../policy-fetch.js';
import { DeltaError, resolvePackObjects } from './delta.js';
import {
  PackBudget,
  PackBudgetError,
  PackFormatError,
  parsePackObjects,
  type BaseObjectType,
  type PackLimits,
} from './pack.js';
import {
  DELIM,
  FLUSH,
  GitRemoteError,
  PktLineError,
  PktLineReader,
  decodeSideband,
  encodePkt,
  type Packet,
} from './pkt-line.js';

export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_TREE_ENTRIES = 20_000;
export const MAX_TREE_BYTES = 64 * 1024 * 1024;
export const MAX_WANTS_PER_REQUEST = 10_000;

const MIB = 1024 * 1024;
const TIMEOUT_MS = 60_000;
const RESULT = 'application/x-git-upload-pack-result';
const REQUEST = 'application/x-git-upload-pack-request';
const OID = /^[0-9a-f]{40}$/;
const TREE_LINE = /^tree ([0-9a-f]{40})$/;
const COMMITTER_LINE = /^committer .*> (\d{1,11})(?: [+-]\d{4})?$/;
const MIN_BISECT_REQUESTS = 64;
const LEGACY_FILE_MODE = '100664';
const FILTER_ERR = /filter/i;
const NOT_OUR_REF = /not our ref/i;
const HEAD_BYTES = 512;
const MAX_CACHED_HOSTS = 1000;

const MODES: ReadonlyMap<string, GitTreeEntryType> = new Map([
  ['100644', 'blob'],
  ['100755', 'blob'],
  ['120000', 'blob'],
  ['40000', 'tree'],
  ['160000', 'commit'],
]);
const strictDecoder = new TextDecoder('utf-8', { fatal: true });
const nameDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const looseDecoder = new TextDecoder();

const LIMITS = {
  docker: { packBytes: 64 * MIB, retainedBytes: 96 * MIB, maxObjects: 200_000 },
  cloudflare: { packBytes: 16 * MIB, retainedBytes: 24 * MIB, maxObjects: 50_000 },
} as const;
export const MAX_OBJECT_BYTES = 8 * MIB;
export const MAX_BLOB_BATCH = 256;
const BODY_CHUNK = 64 * 1024;

type Filter = string | undefined;
const MANIFEST_STRATEGIES: readonly Filter[] = ['tree:1', 'tree:0', 'blob:none', undefined];
const TREE_STRATEGIES: readonly Filter[] = ['blob:none', undefined];
const FULL_ONLY: readonly Filter[] = [undefined];

export type GitFetchErrorCode =
  | 'bad_url'
  | 'bad_path'
  | 'bad_ref'
  | 'bad_response'
  | 'bad_object'
  | 'missing_object'
  | 'too_large'
  | 'tree_too_large'
  | 'git_archive_requires_docker';

/**
 * readFileAtRefs and readTreeAtCommit reject with exactly one of GitFetchError (including pack
 * budget, pack format and delta failures, mapped to too_large or bad_response), GitRemoteError
 * (server ERR or band 3) or UpstreamError (policy fetch refusals, status, timeouts).
 */
export class GitFetchError extends Error {
  readonly code: GitFetchErrorCode;

  constructor(code: GitFetchErrorCode) {
    super(code);
    this.name = 'GitFetchError';
    this.code = code;
  }
}

export interface FilterStrategyCache {
  get(host: string): number | undefined;
  set(host: string, index: number): void;
}

export function createFilterStrategyCache(maxHosts = MAX_CACHED_HOSTS): FilterStrategyCache {
  const map = new Map<string, number>();
  return {
    get: (host) => map.get(host),
    set(host, index) {
      if (map.size >= maxHosts && !map.has(host)) map.clear();
      map.set(host, index);
    },
  };
}

const processCache = createFilterStrategyCache();

export interface GitCapabilities {
  readonly filter: boolean;
}

export interface GitFetchContext {
  readonly policyFetch: PolicyFetch;
  readonly codecs: Codecs;
  readonly runtime: 'docker' | 'cloudflare';
  readonly credential?: UpstreamCredential;
  /** From the discovery the caller already did; absent means unknown and filters are tried. */
  readonly capabilities?: GitCapabilities;
  readonly filterCache?: FilterStrategyCache;
}

export interface GitRefInput {
  readonly name: string;
  readonly oid: string;
  readonly peeled?: string;
}

export type FileReason =
  'missing' | 'not_a_file' | 'too_large' | 'not_utf8' | 'not_a_commit' | 'bad_commit' | 'bad_tree';

export interface FileAtRef {
  readonly ref: string;
  readonly commit: string;
  readonly committedAt: string | null;
  readonly text: string | null;
  readonly reason?: FileReason;
}

export type GitTreeEntryType = 'blob' | 'tree' | 'commit';

export interface GitTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: GitTreeEntryType;
  readonly oid: string;
}

export interface GitTree {
  readonly commit: string;
  readonly committedAt: string;
  readonly entries: GitTreeEntry[];
  /** Entries dropped because their name is not valid UTF-8. */
  readonly skipped: number;
}

interface StoredObject {
  readonly type: BaseObjectType;
  readonly data: Uint8Array;
}

export interface GitFetchLimits {
  readonly packBytes: number;
  readonly retainedBytes: number;
  readonly maxObjects: number;
  readonly maxObjectBytes: number;
}

interface Session {
  readonly ctx: GitFetchContext;
  readonly limits: GitFetchLimits;
  readonly url: string;
  readonly host: string;
  readonly store: Map<string, StoredObject>;
  budget: PackBudget;
  held: number;
}

class FilterRejected extends Error {
  override readonly name = 'FilterRejected';
}

function repository(repoUrl: string): { url: string; host: string } {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new GitFetchError('bad_url');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new GitFetchError('bad_url');
  }
  return {
    url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}/git-upload-pack`,
    host: parsed.host,
  };
}

function runtimeLimits(ctx: GitFetchContext): GitFetchLimits {
  return { ...LIMITS[ctx.runtime], maxObjectBytes: MAX_OBJECT_BYTES };
}

function packLimits(limits: GitFetchLimits, reserved = 0): PackLimits {
  return {
    maxObjects: limits.maxObjects,
    maxRetainedBytes: Math.max(0, limits.retainedBytes - reserved),
    maxObjectBytes: limits.maxObjectBytes,
  };
}

function session(
  ctx: GitFetchContext,
  repoUrl: string,
  limits: GitFetchLimits = runtimeLimits(ctx),
): Session {
  const { url, host } = repository(repoUrl);
  const budget = new PackBudget(packLimits(limits));
  return { ctx, url, host, limits, budget, store: new Map(), held: 0 };
}

function rebudget(s: Session): void {
  s.budget = new PackBudget(packLimits(s.limits, s.held));
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function requestBody(wants: readonly string[], deepen: boolean, filter: Filter): Uint8Array {
  const parts = [
    encodePkt('command=fetch\n'),
    DELIM,
    ...wants.map((oid) => encodePkt(`want ${oid}\n`)),
    ...(deepen ? [encodePkt('deepen 1\n')] : []),
    ...(filter === undefined ? [] : [encodePkt(`filter ${filter}\n`)]),
    encodePkt('no-progress\n'),
    encodePkt('ofs-delta\n'),
    encodePkt('done\n'),
    FLUSH,
  ];
  return concat(
    parts,
    parts.reduce((n, p) => n + p.length, 0),
  );
}

const isFilterError = (text: string): boolean => FILTER_ERR.test(text) && !NOT_OUR_REF.test(text);

function errText(head: Uint8Array): string {
  const length = Number.parseInt(looseDecoder.decode(head.subarray(0, 4)), 16);
  const end = Number.isFinite(length) && length >= 4 ? Math.min(length, head.length) : head.length;
  return looseDecoder.decode(head.subarray(8, end));
}

async function readPack(response: UpstreamResponse, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  let head: Uint8Array = new Uint8Array(0);
  async function* source(): AsyncGenerator<Uint8Array> {
    if (reader === undefined) return;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (head.length < HEAD_BYTES) {
        const part = value.subarray(0, HEAD_BYTES - head.length);
        head = concat([head, part], head.length + part.length);
      }
      yield value;
    }
  }
  try {
    const packets = new PktLineReader(source(), { maxTotalBytes: limit });
    const chunks: Uint8Array[] = [];
    let total = 0;
    let section = '';
    let header = true;
    let started = false;
    let complete = false;
    for (;;) {
      let packet: Packet | null;
      try {
        packet = await packets.next();
      } catch (error) {
        if (error instanceof GitRemoteError && !started && isFilterError(errText(head))) {
          throw new FilterRejected();
        }
        throw error;
      }
      started = true;
      if (packet === null) break;
      if (packet.kind === 'flush' || packet.kind === 'end') {
        complete = true;
        break;
      }
      if (packet.kind === 'delim') {
        header = true;
        continue;
      }
      if (header) {
        section = looseDecoder.decode(packet.data).replace(/\n$/, '');
        header = false;
      } else if (section === 'packfile') {
        const band = decodeSideband(packet.data);
        if (band.band === 1) {
          chunks.push(band.data);
          total += band.data.length;
        }
      }
    }
    if (!complete || section !== 'packfile' || total === 0) {
      throw new GitFetchError('bad_response');
    }
    if ((await packets.next()) !== null) throw new GitFetchError('bad_response');
    return concat(chunks, total);
  } finally {
    void reader?.cancel().catch(() => undefined);
  }
}

async function fetchChunk(
  s: Session,
  wants: readonly string[],
  deepen: boolean,
  filter: Filter,
): Promise<void> {
  const limit = s.limits.packBytes;
  let pack: Uint8Array;
  try {
    const response = await s.ctx.policyFetch({
      url: s.url,
      method: 'POST',
      headers: { 'git-protocol': 'version=2', 'content-type': REQUEST, accept: RESULT },
      body: requestBody(wants, deepen, filter),
      purpose: 'git',
      maxBytes: limit,
      timeoutMs: TIMEOUT_MS,
      ...(s.ctx.credential ? { credential: s.ctx.credential } : {}),
    });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      throw new UpstreamError('http_status', response.status);
    }
    if ((response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim() !== RESULT) {
      void response.body?.cancel().catch(() => undefined);
      throw new GitFetchError('bad_response');
    }
    pack = await readPack(response, limit);
  } catch (error) {
    if (error instanceof UpstreamError && error.code === 'too_large') {
      throw new GitFetchError('too_large');
    }
    if (error instanceof PktLineError) {
      throw new GitFetchError(error.code === 'total_cap' ? 'too_large' : 'bad_response');
    }
    throw error;
  }
  const { codecs } = s.ctx;
  const parsed = await parsePackObjects(pack, codecs, s.budget);
  const resolved = await resolvePackObjects(parsed, codecs, s.budget);
  for (const object of resolved.objects) {
    s.held += object.data.length - (s.store.get(object.oid)?.data.length ?? 0);
    s.store.set(object.oid, { type: object.type, data: object.data });
  }
}

async function fetchPack(
  s: Session,
  wants: readonly string[],
  deepen: boolean,
  filter: Filter,
): Promise<void> {
  for (let at = 0; at < wants.length; at += MAX_WANTS_PER_REQUEST) {
    await fetchChunk(s, wants.slice(at, at + MAX_WANTS_PER_REQUEST), deepen, filter);
  }
}

async function fetchFiltered(
  s: Session,
  wants: readonly string[],
  deepen: boolean,
  strategies: readonly Filter[],
  remember: boolean,
): Promise<void> {
  const cache = s.ctx.filterCache ?? processCache;
  const usable = s.ctx.capabilities?.filter === false ? FULL_ONLY : strategies;
  const useCache = remember && usable === strategies;
  let i = useCache ? Math.min(cache.get(s.host) ?? 0, usable.length - 1) : 0;
  for (let at = 0; at < wants.length; at += MAX_WANTS_PER_REQUEST) {
    const chunk = wants.slice(at, at + MAX_WANTS_PER_REQUEST);
    for (;;) {
      try {
        await fetchChunk(s, chunk, deepen, usable[i]);
        break;
      } catch (error) {
        if (!(error instanceof FilterRejected)) throw error;
        if (i >= usable.length - 1) throw new GitRemoteError('remote_error');
        i += 1;
      }
    }
  }
  if (useCache) cache.set(s.host, i);
}

function mapFailure(error: unknown): never {
  if (error instanceof PackBudgetError) throw new GitFetchError('too_large');
  if (error instanceof PackFormatError || error instanceof DeltaError) {
    throw new GitFetchError('bad_response');
  }
  throw error;
}

function lookup(s: Session, oid: string, type: BaseObjectType): Uint8Array {
  const object = s.store.get(oid);
  if (object === undefined) throw new GitFetchError('missing_object');
  if (object.type !== type) throw new GitFetchError('bad_object');
  return object.data;
}

function parseCommit(data: Uint8Array): { tree: string; committedAt: string } {
  let end = data.length;
  for (let i = 0; i + 1 < data.length; i++) {
    if (data[i] === 0x0a && data[i + 1] === 0x0a) {
      end = i;
      break;
    }
  }
  const lines = looseDecoder.decode(data.subarray(0, end)).split('\n');
  const tree = TREE_LINE.exec(lines[0] ?? '')?.[1];
  const seconds = lines
    .map((line) => COMMITTER_LINE.exec(line)?.[1])
    .find((value) => value !== undefined);
  if (tree === undefined || seconds === undefined) throw new GitFetchError('bad_object');
  return { tree, committedAt: new Date(Number(seconds) * 1000).toISOString() };
}

interface RawEntry {
  readonly mode: string;
  readonly nameBytes: Uint8Array;
  readonly oid: string;
}

function* rawEntries(data: Uint8Array): Generator<RawEntry> {
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = space < 0 ? -1 : data.indexOf(0, space);
    if (nul < 0 || nul + 21 > data.length) throw new GitFetchError('bad_object');
    yield {
      mode: looseDecoder.decode(data.subarray(i, space)),
      nameBytes: data.subarray(space + 1, nul),
      oid: hex(data.subarray(nul + 1, nul + 21)),
    };
    i = nul + 21;
  }
}

function decodeName(bytes: Uint8Array): string | null {
  try {
    return nameDecoder.decode(bytes);
  } catch {
    return null;
  }
}

const isIgnorable = (c: number): boolean =>
  (c >= 0x200c && c <= 0x200f) ||
  (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x206a && c <= 0x206f) ||
  c === 0xfeff;

function validName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  let folded = '';
  for (const char of name) {
    const c = char.codePointAt(0) as number;
    if (c < 0x20 || c === 0x7f || char === '/' || char === '\\') return false;
    if (!isIgnorable(c)) folded += char;
  }
  const stem = (folded.split(':', 1)[0] as string).replace(/[. ]+$/, '').toLowerCase();
  return stem !== '.git' && !/^(?:git|gi7eba)~\d+$/.test(stem);
}

interface TreeItem {
  readonly mode: string;
  readonly name: string;
  readonly type: GitTreeEntryType;
  readonly oid: string;
}

function parseTree(data: Uint8Array): { items: TreeItem[]; skipped: number } {
  const items: TreeItem[] = [];
  let skipped = 0;
  const names = new Set<string>();
  for (const raw of rawEntries(data)) {
    const name = decodeName(raw.nameBytes);
    if (name === null) {
      skipped += 1;
      continue;
    }
    const type = MODES.get(raw.mode);
    if (type === undefined || !validName(name) || names.has(name)) {
      throw new GitFetchError('bad_object');
    }
    names.add(name);
    items.push({ mode: raw.mode, name, type, oid: raw.oid });
  }
  return { items, skipped };
}

type Located = { readonly oid: string } | { readonly reason: FileReason };

function locate(data: Uint8Array, path: string): Located {
  try {
    for (const raw of rawEntries(data)) {
      if (decodeName(raw.nameBytes) !== path) continue;
      const type = raw.mode === LEGACY_FILE_MODE ? 'blob' : MODES.get(raw.mode);
      if (type === undefined) return { reason: 'bad_tree' };
      return type === 'blob' && raw.mode !== '120000' ? { oid: raw.oid } : { reason: 'not_a_file' };
    }
  } catch (error) {
    if (error instanceof GitFetchError) return { reason: 'bad_tree' };
    throw error;
  }
  return { reason: 'missing' };
}

function commitOids(refs: readonly GitRefInput[]): string[] {
  return refs.map((ref) => {
    const oid = ref.peeled ?? ref.oid;
    if (!OID.test(oid)) throw new GitFetchError('bad_ref');
    return oid;
  });
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

function decodeText(bytes: Uint8Array): string | null {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return null;
  }
}

function readText(data: Uint8Array): { text: string } | { reason: FileReason } {
  if (data.length > MAX_MANIFEST_BYTES) return { reason: 'too_large' };
  const text = decodeText(data);
  return text === null ? { reason: 'not_utf8' } : { text };
}

/**
 * Fetches blobs in one batch. A blob over the object cap, or one whose pack exceeds the response
 * cap, is isolated by bisection (at most max(2*ceil(log2(n+1)) + 2, 64) extra requests, enough for a handful of oversized blobs) and reported in the
 * returned set so only its ref fails. Exhausting the retained-bytes budget fails the call with
 * too_large, because a smaller batch cannot free bytes already held.
 */
async function fetchBlobs(s: Session, oids: readonly string[]): Promise<Set<string>> {
  const oversize = new Set<string>();
  const allowed = Math.max(2 * Math.ceil(Math.log2(oids.length + 1)) + 2, MIN_BISECT_REQUESTS);
  let extra = 0;
  const attempt = async (batch: readonly string[], retry: boolean): Promise<void> => {
    const pending = batch.filter((oid) => !s.store.has(oid));
    if (pending.length === 0) return;
    if (retry && ++extra > allowed) throw new GitFetchError('too_large');
    rebudget(s);
    try {
      await fetchPack(s, pending, false, undefined);
    } catch (error) {
      const tooBig =
        (error instanceof PackBudgetError && error.code === 'object_bytes') ||
        (error instanceof GitFetchError && error.code === 'too_large');
      if (!tooBig) throw error;
      if (pending.length === 1) {
        oversize.add(pending[0] as string);
        return;
      }
      const middle = pending.length >> 1;
      await attempt(pending.slice(0, middle), true);
      await attempt(pending.slice(middle), true);
    }
  };
  await attempt(oids, false);
  return oversize;
}

type CommitInfo =
  { readonly tree: string; readonly committedAt: string } | { readonly reason: FileReason };

async function readFiles(
  s: Session,
  refs: readonly GitRefInput[],
  commits: readonly string[],
  path: string,
): Promise<FileAtRef[]> {
  await fetchFiltered(s, unique(commits), true, MANIFEST_STRATEGIES, true);

  const infos = new Map<string, CommitInfo>();
  for (const oid of unique(commits)) {
    const object = s.store.get(oid);
    if (object === undefined) throw new GitFetchError('missing_object');
    if (object.type !== 'commit') {
      infos.set(oid, { reason: 'not_a_commit' });
      continue;
    }
    try {
      infos.set(oid, parseCommit(object.data));
    } catch (error) {
      if (!(error instanceof GitFetchError)) throw error;
      infos.set(oid, { reason: 'bad_commit' });
    }
  }

  const trees = unique([...infos.values()].flatMap((info) => ('tree' in info ? [info.tree] : [])));
  const missingTrees = trees.filter((oid) => !s.store.has(oid));
  if (missingTrees.length > 0) {
    await fetchFiltered(s, missingTrees, false, MANIFEST_STRATEGIES, true);
  }

  const located = new Map<string, Located>();
  for (const tree of trees) {
    const object = s.store.get(tree);
    if (object === undefined) throw new GitFetchError('missing_object');
    located.set(tree, object.type === 'tree' ? locate(object.data, path) : { reason: 'bad_tree' });
  }

  const wanted = unique([...located.values()].flatMap((l) => ('oid' in l ? [l.oid] : [])));
  const missingBlobs = wanted.filter((oid) => !s.store.has(oid));
  const oversize = missingBlobs.length > 0 ? await fetchBlobs(s, missingBlobs) : new Set<string>();

  return refs.map((ref, n) => {
    const commit = commits[n] as string;
    const info = infos.get(commit) as CommitInfo;
    if ('reason' in info) return { ref: ref.name, commit, committedAt: null, text: null, ...info };
    const base = { ref: ref.name, commit, committedAt: info.committedAt };
    const file = located.get(info.tree) as Located;
    if ('reason' in file) return { ...base, text: null, reason: file.reason };
    if (oversize.has(file.oid)) return { ...base, text: null, reason: 'too_large' as const };
    const blob = s.store.get(file.oid);
    if (blob === undefined) throw new GitFetchError('missing_object');
    if (blob.type !== 'blob') return { ...base, text: null, reason: 'bad_tree' as const };
    const read = readText(blob.data);
    return 'text' in read ? { ...base, text: read.text } : { ...base, text: null, ...read };
  });
}

export async function readFileAtRefs(
  ctx: GitFetchContext,
  repoUrl: string,
  refs: readonly GitRefInput[],
  path: string,
): Promise<FileAtRef[]> {
  if (!validName(path)) throw new GitFetchError('bad_path');
  const commits = commitOids(refs);
  const s = session(ctx, repoUrl);
  if (refs.length === 0) return [];
  try {
    return await readFiles(s, refs, commits, path);
  } catch (error) {
    return mapFailure(error);
  }
}

async function walkTree(s: Session, commit: string): Promise<GitTree> {
  await fetchFiltered(s, [commit], true, TREE_STRATEGIES, false);
  const { tree, committedAt } = parseCommit(lookup(s, commit, 'commit'));

  let count = 0;
  let bytes = 0;
  let skipped = 0;
  const load = (oid: string): TreeItem[] => {
    const data = lookup(s, oid, 'tree');
    bytes += data.length;
    const parsed = parseTree(data);
    const items = parsed.items;
    skipped += parsed.skipped;
    count += items.length + parsed.skipped;
    if (count > MAX_TREE_ENTRIES || bytes > MAX_TREE_BYTES) {
      throw new GitFetchError('tree_too_large');
    }
    return items;
  };

  const entries: GitTreeEntry[] = [];
  const stack = [{ items: load(tree), next: 0, prefix: '' }];
  for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
    const item = top.items[top.next++];
    if (item === undefined) {
      stack.pop();
      continue;
    }
    const entryPath = `${top.prefix}${item.name}`;
    entries.push({ path: entryPath, mode: item.mode, type: item.type, oid: item.oid });
    if (item.type === 'tree') {
      stack.push({ items: load(item.oid), next: 0, prefix: `${entryPath}/` });
    }
  }
  return { commit, committedAt, entries, skipped };
}

export async function readTreeAtCommit(
  ctx: GitFetchContext,
  repoUrl: string,
  commit: string,
): Promise<GitTree> {
  if (ctx.runtime === 'cloudflare') throw new GitFetchError('git_archive_requires_docker');
  if (!OID.test(commit)) throw new GitFetchError('bad_ref');
  const s = session(ctx, repoUrl);
  try {
    return await walkTree(s, commit);
  } catch (error) {
    return mapFailure(error);
  }
}

export interface GitBlobReader {
  read(
    oid: string,
    maxBytes: number,
  ): Promise<{ readonly size: number; readonly body: ReadableStream<Uint8Array> }>;
}

function drop(s: Session, oid: string): void {
  const object = s.store.get(oid);
  if (object === undefined) return;
  s.store.delete(oid);
  s.held -= object.data.length;
}

function chunked(data: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }
      controller.enqueue(data.slice(offset, offset + BODY_CHUNK));
      offset += BODY_CHUNK;
    },
  });
}

/**
 * Reads blobs of `plan` by oid, prefetching up to MAX_BLOB_BATCH not-yet-read plan oids per
 * request. Returned objects leave the session store, so a repeated read refetches. The retained
 * budget charges both the raw pack and the inflated objects; when a batch overflows it, or the
 * batch exhausts the bisection request budget of fetchBlobs, the store is cleared and the batch
 * window halves for the rest of the reader's life.
 */
export interface GitBlobReaderOptions {
  /** Each value is capped at the runtime default; a limit can only be lowered. */
  readonly limits?: Partial<GitFetchLimits>;
}

function lowered(ctx: GitFetchContext, wanted: Partial<GitFetchLimits> = {}): GitFetchLimits {
  const base = runtimeLimits(ctx);
  const pick = (key: keyof GitFetchLimits): number => {
    const value = wanted[key];
    if (value === undefined) return base[key];
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${key} must be positive`);
    return Math.min(value, base[key]);
  };
  return {
    packBytes: pick('packBytes'),
    retainedBytes: pick('retainedBytes'),
    maxObjects: pick('maxObjects'),
    maxObjectBytes: pick('maxObjectBytes'),
  };
}

export function createGitBlobReader(
  ctx: GitFetchContext,
  repoUrl: string,
  plan: readonly string[],
  options: GitBlobReaderOptions = {},
): GitBlobReader {
  if (ctx.runtime === 'cloudflare') throw new GitFetchError('git_archive_requires_docker');
  for (const oid of plan) if (!OID.test(oid)) throw new GitFetchError('bad_ref');
  const s = session(ctx, repoUrl, lowered(ctx, options.limits));
  const order = unique(plan);
  const position = new Map(order.map((oid, n) => [oid, n]));
  const returned = new Set<string>();
  const oversize = new Set<string>();
  let window = MAX_BLOB_BATCH;

  const batchFrom = (oid: string, at: number): string[] => {
    const batch = [oid];
    for (let n = at + 1; n < order.length && batch.length < window; n++) {
      const next = order[n] as string;
      if (!returned.has(next) && !oversize.has(next)) batch.push(next);
    }
    return batch;
  };

  const settle = (oid: string, found: Set<string>): void => {
    for (const big of found) oversize.add(big);
    for (const key of [...s.store.keys()]) {
      if (key !== oid && (!position.has(key) || returned.has(key))) drop(s, key);
    }
  };

  const load = async (oid: string, at: number): Promise<void> => {
    for (;;) {
      const batch = batchFrom(oid, at);
      try {
        settle(oid, await fetchBlobs(s, batch));
        return;
      } catch (error) {
        const overflow =
          (error instanceof PackBudgetError && error.code === 'retained_bytes') ||
          (error instanceof GitFetchError && error.code === 'too_large');
        if (!overflow || batch.length === 1) throw error;
        for (const key of [...s.store.keys()]) drop(s, key);
        window = batch.length >> 1;
      }
    }
  };

  const take = async (oid: string, maxBytes: number) => {
    const at = position.get(oid);
    if (at === undefined) throw new GitFetchError('missing_object');
    if (oversize.has(oid)) throw new GitFetchError('too_large');
    try {
      if (!s.store.has(oid)) await load(oid, at);
    } catch (error) {
      return mapFailure(error);
    }
    if (oversize.has(oid)) throw new GitFetchError('too_large');
    const object = s.store.get(oid);
    if (object === undefined) throw new GitFetchError('missing_object');
    if (object.type !== 'blob' || object.data.length > maxBytes) {
      drop(s, oid);
      rebudget(s);
      throw new GitFetchError(object.type !== 'blob' ? 'bad_object' : 'too_large');
    }
    drop(s, oid);
    rebudget(s);
    returned.add(oid);
    return { size: object.data.length, body: chunked(object.data) };
  };

  let queue: Promise<unknown> = Promise.resolve();
  return {
    read(oid, maxBytes) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        return Promise.reject(new TypeError('maxBytes must be a non-negative safe integer'));
      }
      const result = queue.then(() => take(oid, maxBytes));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
