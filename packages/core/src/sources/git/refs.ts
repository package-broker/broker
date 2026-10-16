import {
  UpstreamError,
  type PolicyFetch,
  type UpstreamCredential,
  type UpstreamResponse,
} from '../policy-fetch.js';
import { DELIM, FLUSH, PktLineError, PktLineReader, encodePkt } from './pkt-line.js';
import type { Packet } from './pkt-line.js';

export const MAX_LS_REFS_BYTES = 8 * 1024 * 1024;
export const MAX_LS_REFS_LINES = 50_000;
const MAX_CAPABILITY_LINES = 1000;

const TIMEOUT_MS = 60_000;
const ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RESULT = 'application/x-git-upload-pack-result';
const REQUEST = 'application/x-git-upload-pack-request';
const SERVICE_LINE = '# service=git-upload-pack';
const AGENT = 'package-broker';
const OID = /^[0-9a-f]{40}$/;
const NAME_CHARS = /^[\x21-\x7e]+$/;
const FORBIDDEN = /[~^:?*[\\]/;
const MAX_NAME = 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

export type GitRefsErrorCode =
  'bad_url' | 'not_smart' | 'unsupported_protocol' | 'bad_response' | 'too_large';

/**
 * lsRefs rejects with exactly one of GitRefsError, GitRemoteError (server ERR
 * or band 3) or UpstreamError (policy fetch refusals, status, timeouts).
 */
export class GitRefsError extends Error {
  readonly code: GitRefsErrorCode;
  readonly reason: string | undefined;

  constructor(code: GitRefsErrorCode, reason?: string) {
    super(code);
    this.name = 'GitRefsError';
    this.code = code;
    this.reason = reason;
  }
}

export interface GitRef {
  readonly name: string;
  readonly oid: string;
  readonly peeled?: string;
  readonly symref?: string;
}

export interface GitRefs {
  readonly refs: GitRef[];
  /** Refs in the requested prefixes that were dropped for an invalid name; HEAD with a bad symref target counts once. */
  readonly skipped: number;
}

const bad = (reason?: string): GitRefsError => new GitRefsError('bad_response', reason);

function baseUrl(repoUrl: string): string {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    throw new GitRefsError('bad_url');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new GitRefsError('bad_url');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function mediaType(response: UpstreamResponse): string {
  return (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

function open(response: UpstreamResponse): {
  source: AsyncGenerator<Uint8Array>;
  cancel: () => void;
} {
  const reader = response.body?.getReader();
  const cancel = (): void => {
    void reader?.cancel().catch(() => undefined);
  };
  async function* source(): AsyncGenerator<Uint8Array> {
    if (reader === undefined) return;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  }
  return { source: source(), cancel };
}

function text(data: Uint8Array): string {
  let line: string;
  try {
    line = decoder.decode(data);
  } catch {
    throw bad('encoding');
  }
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

async function collect(
  reader: PktLineReader,
  first: Packet | null,
  onLine: (line: string, count: number) => void,
  maxLines = Number.POSITIVE_INFINITY,
): Promise<void> {
  let packet = first;
  let count = 0;
  for (;;) {
    if (packet === null) throw bad('truncated');
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') throw bad('framing');
    count += 1;
    if (count > maxLines) throw bad('too_many_lines');
    onLine(text(packet.data), count);
    packet = await reader.next();
  }
  if ((await reader.next()) !== null) throw bad('trailing');
}

function validName(name: string): boolean {
  if (name.length > MAX_NAME || !NAME_CHARS.test(name) || FORBIDDEN.test(name)) return false;
  if (name === '@' || name.includes('@{') || name.includes('..')) return false;
  if (name.endsWith('/') || name.endsWith('.')) return false;
  return name
    .split('/')
    .every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

const isHead = (name: string): boolean => name === 'HEAD';
const isTag = (name: string): boolean => name.startsWith('refs/tags/');
const inPrefixes = (name: string): boolean =>
  isHead(name) || name.startsWith('refs/heads/') || isTag(name);
const validTarget = (name: string): boolean =>
  (name.startsWith('refs/heads/') || isTag(name)) && validName(name);

async function discover(
  policyFetch: PolicyFetch,
  base: string,
  credential: UpstreamCredential | undefined,
): Promise<{ agent: boolean; used: number }> {
  const response = await policyFetch({
    url: `${base}/info/refs?service=git-upload-pack`,
    method: 'GET',
    headers: { 'git-protocol': 'version=2', accept: ADVERTISEMENT },
    purpose: 'git',
    maxBytes: MAX_LS_REFS_BYTES,
    timeoutMs: TIMEOUT_MS,
    ...(credential ? { credential } : {}),
  });
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    throw new UpstreamError('http_status', response.status);
  }
  if (mediaType(response) !== ADVERTISEMENT) {
    void response.body?.cancel().catch(() => undefined);
    throw new GitRefsError('not_smart');
  }
  const { source, cancel } = open(response);
  try {
    const reader = new PktLineReader(source, { maxTotalBytes: MAX_LS_REFS_BYTES });
    let packet = await reader.next();
    if (packet?.kind === 'data' && text(packet.data).startsWith('# service=')) {
      if (text(packet.data) !== SERVICE_LINE) throw new GitRefsError('not_smart');
      packet = await reader.next();
      if (packet?.kind === 'flush') packet = await reader.next();
    }
    const lines: string[] = [];
    await collect(reader, packet, (line) => lines.push(line), MAX_CAPABILITY_LINES);
    if (lines[0] !== 'version 2') throw new GitRefsError('unsupported_protocol');
    const caps = lines.slice(1);
    if (!caps.some((c) => c === 'ls-refs' || c.startsWith('ls-refs='))) {
      throw new GitRefsError('unsupported_protocol');
    }
    const format = caps.find((c) => c.startsWith('object-format='));
    if (format !== undefined && format !== 'object-format=sha1') {
      throw new GitRefsError('unsupported_protocol');
    }
    return { agent: caps.some((c) => c.startsWith('agent=')), used: reader.consumedBytes };
  } finally {
    cancel();
  }
}

function parseLine(
  line: string,
  seen: Set<string>,
  out: GitRef[],
): 'kept' | 'filtered' | 'skipped' {
  const [oid, name, ...attrs] = line.split(' ');
  if (oid === undefined || name === undefined || name === '' || !OID.test(oid)) throw bad('line');
  let peeled: string | undefined;
  let target: string | undefined;
  for (const attr of attrs) {
    if (attr.startsWith('peeled:')) {
      if (peeled !== undefined) throw bad('attribute');
      peeled = attr.slice('peeled:'.length);
      if (!OID.test(peeled)) throw bad('attribute');
    } else if (attr.startsWith('symref-target:')) {
      if (target !== undefined) throw bad('attribute');
      target = attr.slice('symref-target:'.length);
    }
  }
  if (!inPrefixes(name)) return 'filtered';
  if (seen.has(name)) throw bad('duplicate');
  seen.add(name);
  if (!isHead(name) && !validName(name)) return 'skipped';
  const symref = target !== undefined && validTarget(target) ? target : undefined;
  out.push({
    name,
    oid,
    ...(peeled !== undefined && isTag(name) ? { peeled } : {}),
    ...(symref !== undefined ? { symref } : {}),
  });
  return isHead(name) && target !== undefined && symref === undefined ? 'skipped' : 'kept';
}

async function run(
  policyFetch: PolicyFetch,
  repoUrl: string,
  credential: UpstreamCredential | undefined,
): Promise<GitRefs> {
  const base = baseUrl(repoUrl);
  const { agent, used } = await discover(policyFetch, base, credential);
  const budget = MAX_LS_REFS_BYTES - used;
  if (budget <= 0) throw new GitRefsError('too_large');

  const body = concat([
    encodePkt('command=ls-refs\n'),
    ...(agent ? [encodePkt(`agent=${AGENT}\n`)] : []),
    DELIM,
    encodePkt('peel\n'),
    encodePkt('symrefs\n'),
    encodePkt('ref-prefix HEAD\n'),
    encodePkt('ref-prefix refs/heads/\n'),
    encodePkt('ref-prefix refs/tags/\n'),
    FLUSH,
  ]);
  const response = await policyFetch({
    url: `${base}/git-upload-pack`,
    method: 'POST',
    headers: {
      'git-protocol': 'version=2',
      'content-type': REQUEST,
      accept: RESULT,
    },
    body,
    purpose: 'git',
    maxBytes: budget,
    timeoutMs: TIMEOUT_MS,
    ...(credential ? { credential } : {}),
  });
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    throw new UpstreamError('http_status', response.status);
  }
  if (mediaType(response) !== RESULT) {
    void response.body?.cancel().catch(() => undefined);
    throw new GitRefsError('not_smart');
  }
  const { source, cancel } = open(response);
  try {
    const reader = new PktLineReader(source, { maxTotalBytes: budget });
    const refs: GitRef[] = [];
    const seen = new Set<string>();
    let skipped = 0;
    await collect(reader, await reader.next(), (line, count) => {
      if (count > MAX_LS_REFS_LINES) throw bad('too_many_refs');
      if (parseLine(line, seen, refs) === 'skipped') skipped += 1;
    });
    return { refs, skipped };
  } finally {
    cancel();
  }
}

export async function lsRefs(
  policyFetch: PolicyFetch,
  repoUrl: string,
  credential?: UpstreamCredential,
): Promise<GitRefs> {
  try {
    return await run(policyFetch, repoUrl, credential);
  } catch (error) {
    if (error instanceof UpstreamError && error.code === 'too_large') {
      throw new GitRefsError('too_large');
    }
    if (error instanceof PktLineError) {
      throw error.code === 'total_cap' ? new GitRefsError('too_large') : bad();
    }
    throw error;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
