import { packageKey, PackageNameError } from '../../catalogue/names.js';
import { isPatternSyntax, matchesPattern } from '../../catalogue/patterns.js';
import type { VersionInput } from '../../db/catalogue.js';
import { isoTimestamp, type Clock } from '../../ids.js';
import {
  expandVersions,
  ExpansionLimitError,
  type ExpansionLimits,
} from '../../registry/composer/minify.js';
import {
  composerVersionInput,
  type ComposerVersionSkip,
} from '../../registry/composer/version-object.js';
import type { CredentialEchoProbe } from '../../sources/credentials.js';
import {
  UpstreamError,
  type PolicyFetch,
  type UpstreamCredential,
  type UpstreamResponse,
  type UpstreamRequest,
} from '../../sources/policy-fetch.js';
import {
  createPackageDescription,
  snapshotRef,
  type ComposerForm,
  type DescribeResult,
  type DocumentValidators,
  type FormEvidence,
  type Validators,
  type VersionCandidate,
} from '../../sources/provider.js';
import { ARRAY_ELEMENTS, extractMembers } from '../json-stream.js';
import type { ComposerRoot } from './root.js';

export type ComposerV2ErrorCode =
  'refused' | 'timeout' | 'too_large' | 'http_status' | 'network' | 'unsupported';

export class ComposerV2Error extends Error {
  override readonly name = 'ComposerV2Error';
  constructor(
    readonly code: ComposerV2ErrorCode,
    readonly status?: number,
  ) {
    super(`composer v2 package ${code}${status === undefined ? '' : ` (${status})`}`);
  }
}

export interface ComposerV2Source {
  readonly root: ComposerRoot;
  /** Origins besides the metadata-url origin that the fetch may reach. */
  readonly allowedOrigins: readonly string[];
  readonly credential?: UpstreamCredential;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly expansion?: ExpansionLimits;
}

export interface ComposerV2Options {
  readonly redirect?: UpstreamRequest['redirects'];
  readonly dev?: boolean;
  readonly validators?: DocumentValidators;
  /** The request path never sleeps; jobs honour Retry-After and recheck authenticated 404s. */
  readonly path: 'job' | 'request';
  readonly probe: CredentialEchoProbe;
  readonly clock: Clock;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly onSkip?: (reason: ComposerVersionSkip) => void;
}

export type ComposerV2Candidate = VersionCandidate & {
  readonly input: VersionInput;
  readonly stripped: number;
};

export type ComposerV2Result =
  DescribeResult | { readonly kind: 'busy'; readonly retryAfterSeconds: number | null };

/** Peak memory per call is about two buffered documents plus the parsed versions of one. */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_VERSION_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_EXPANSION: ExpansionLimits = { maxVersions: 20_000 };
const MAX_RETRY_AFTER_SECONDS = 60;
const RECHECK_MS = 1500;
const MAX_UPSTREAM_PATTERNS = 1000;
const MAX_UPSTREAM_PATTERN_LENGTH = 255;
const STRONG_ETAG = /^"[^"]+"$/;
const ABSENT_SNAPSHOT = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const CHUNK = 64 * 1024;
const encoder = new TextEncoder();

type Fetched =
  | { readonly kind: 'body'; readonly bytes: Uint8Array; readonly validators: Validators }
  | { readonly kind: 'not_modified' }
  | { readonly kind: 'missing'; readonly bytes: Uint8Array }
  | { readonly kind: 'busy'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'failed'; readonly error: ComposerV2Error };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function hasValidator(validators: Validators | undefined): validators is Validators {
  return validators?.etag !== undefined || validators?.lastModified !== undefined;
}

function listing(root: ComposerRoot, key: string): boolean | null {
  const { availablePackages: packages, availablePatterns: patterns } = root;
  if (packages === undefined && patterns === undefined) return null;
  if (packages?.includes(key) === true) return true;
  if (patterns === undefined) return false;
  if (patterns.length > MAX_UPSTREAM_PATTERNS) return null;
  for (const raw of patterns) {
    const pattern = raw.toLowerCase();
    if (!isPatternSyntax(pattern, MAX_UPSTREAM_PATTERN_LENGTH)) return null;
    if (matchesPattern(pattern, key)) return true;
  }
  return false;
}

function retryAfterOf(value: string | null, now: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

async function readAll(response: UpstreamResponse): Promise<Uint8Array> {
  return response.body === null
    ? new Uint8Array(0)
    : new Uint8Array(await new Response(response.body).arrayBuffer());
}

async function digest(scheme: string, parts: readonly Uint8Array[]): Promise<string> {
  const pieces: Uint8Array[] = [encoder.encode(`${scheme}\n`)];
  for (const part of parts) pieces.push(encoder.encode(`${part.length}:`), part);
  const joined = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let at = 0;
  for (const piece of pieces) {
    joined.set(piece, at);
    at += piece.length;
  }
  const hash = await crypto.subtle.digest('SHA-256', joined);
  return `sha256:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function isJson(bytes: Uint8Array): boolean {
  try {
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return true;
  } catch {
    return false;
  }
}

function chunks(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(at, at + CHUNK));
      at += CHUNK;
    },
  });
}

function upstreamFailure(error: unknown): Fetched {
  if (error instanceof UpstreamError) {
    return { kind: 'failed', error: new ComposerV2Error(error.code, error.status) };
  }
  throw error;
}

export async function describeComposerV2(
  fetch: PolicyFetch,
  source: ComposerV2Source,
  name: string,
  options: ComposerV2Options,
): Promise<ComposerV2Result> {
  const { root } = source;
  if (root.mode !== 'v2' || root.metadataUrl === undefined) {
    throw new ComposerV2Error('unsupported');
  }
  let key: string;
  try {
    key = packageKey(name, { ecosystem: 'composer' });
  } catch (error) {
    if (error instanceof PackageNameError) return { kind: 'not_found', definitive: false };
    throw error;
  }
  const listed = listing(root, key);
  if (listed === false) return { kind: 'not_found', definitive: false };

  const job = options.path === 'job';
  const sleep = options.sleep ?? defaultSleep;
  const metadataUrl = root.metadataUrl;
  const urlOf = (path: string): string => metadataUrl.replaceAll('%package%', () => path);
  const destinations = [new URL(urlOf('vendor/package')).origin, ...source.allowedOrigins];
  const maxBytes = source.maxBytes ?? DEFAULT_MAX_BYTES;

  const controller = new AbortController();
  const outer = options.signal;
  if (outer !== undefined) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
  }
  const signal = controller.signal;
  const pause = (ms: number): Promise<void> => {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() => sleep(ms))
        .then(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, reject);
    });
  };

  const request = async (form: ComposerForm, conditional: boolean): Promise<Fetched> => {
    const url = urlOf(form === 'composer-p2' ? key : `${key}~dev`);
    const stored = conditional ? options.validators?.[form] : undefined;
    const sent = hasValidator(stored);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (stored?.etag !== undefined) headers['if-none-match'] = stored.etag;
    if (stored?.lastModified !== undefined) headers['if-modified-since'] = stored.lastModified;
    let retried = false;
    let rechecked = false;
    for (;;) {
      let response: UpstreamResponse;
      try {
        response = await fetch({
          url,
          method: 'GET',
          headers,
          ...(source.credential === undefined ? {} : { credential: source.credential }),
          destinations,
          ...(options.redirect === undefined ? {} : { redirects: options.redirect }),
          purpose: 'metadata',
          maxBytes,
          timeoutMs: source.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal,
        });
      } catch (error) {
        return upstreamFailure(error);
      }
      try {
        if (response.status === 429) {
          await response.body?.cancel();
          const seconds = retryAfterOf(
            response.headers.get('retry-after'),
            options.clock.now().getTime(),
          );
          if (job && !retried && seconds !== null && seconds <= MAX_RETRY_AFTER_SECONDS) {
            retried = true;
            await pause(seconds * 1000);
            continue;
          }
          return { kind: 'busy', retryAfterSeconds: seconds };
        }
        if (response.status === 304) {
          if (sent) return { kind: 'not_modified' };
          return { kind: 'failed', error: new ComposerV2Error('http_status', 304) };
        }
        if (response.status === 404) {
          const bytes = await readAll(response);
          const recheck =
            form === 'composer-p2' && job && source.credential !== undefined && listed === true;
          if (recheck && !rechecked) {
            rechecked = true;
            await pause(RECHECK_MS);
            continue;
          }
          return { kind: 'missing', bytes };
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          return { kind: 'failed', error: new ComposerV2Error('http_status', response.status) };
        }
        const etag = response.headers.get('etag') ?? undefined;
        const lastModified = response.headers.get('last-modified') ?? undefined;
        return {
          kind: 'body',
          bytes: await readAll(response),
          validators: {
            ...(etag === undefined ? {} : { etag }),
            ...(lastModified === undefined ? {} : { lastModified }),
          },
        };
      } catch (error) {
        await response.body?.cancel().catch(() => undefined);
        return upstreamFailure(error);
      }
    }
  };
  const guarded = (pending: Promise<Fetched>): Promise<Fetched> =>
    pending.catch((error: unknown) => {
      controller.abort(error);
      throw error;
    });

  let [p2, dev] = await Promise.all([
    guarded(request('composer-p2', true)),
    options.dev === true ? guarded(request('composer-p2-dev', true)) : Promise.resolve(null),
  ]);
  if (p2.kind === 'busy') return p2;
  if (dev?.kind === 'busy') return dev;
  if (p2.kind === 'failed') throw p2.error;
  if (p2.kind === 'missing') return { kind: 'not_found', definitive: isJson(p2.bytes) };

  const devChanged =
    dev !== null &&
    (dev.kind === 'body' ||
      (dev.kind === 'missing' && hasValidator(options.validators?.['composer-p2-dev'])));
  if (p2.kind === 'not_modified') {
    if (dev?.kind === 'failed') throw dev.error;
    if (!devChanged) return { kind: 'not_modified' };
    p2 = await request('composer-p2', false);
    if (p2.kind === 'busy') return p2;
    if (p2.kind === 'failed') throw p2.error;
    if (p2.kind !== 'body') throw new ComposerV2Error('http_status', 404);
  }
  if (dev?.kind === 'not_modified') {
    dev = await request('composer-p2-dev', false);
    if (dev.kind === 'busy') return dev;
  }

  const forms: FormEvidence[] = [];
  const validators: DocumentValidators = {};
  const bodies: { form: ComposerForm; bytes: Uint8Array }[] = [];
  const parts: Uint8Array[] = [];
  let strong = true;
  const record = async (form: ComposerForm, fetched: Fetched | null): Promise<boolean> => {
    if (fetched?.kind === 'missing') {
      forms.push({
        form,
        status: 'absent',
        snapshot: snapshotRef(ABSENT_SNAPSHOT),
        validators: {},
      });
      parts.push(encoder.encode(form), encoder.encode(ABSENT_SNAPSHOT));
      return true;
    }
    if (fetched?.kind !== 'body') return false;
    const etag = fetched.validators.etag;
    const isStrong = etag !== undefined && STRONG_ETAG.test(etag);
    strong &&= isStrong;
    const id = isStrong ? etag : await digest('composer-v2-form', [fetched.bytes]);
    forms.push({
      form,
      status: 'present',
      snapshot: snapshotRef(id),
      validators: fetched.validators,
    });
    validators[form] = fetched.validators;
    bodies.push({ form, bytes: fetched.bytes });
    parts.push(encoder.encode(form), isStrong ? encoder.encode(etag) : fetched.bytes);
    return true;
  };
  await record('composer-p2', p2);
  const devRecorded = await record('composer-p2-dev', dev);
  const snapshot = await digest(strong ? 'composer-v2-etag' : 'composer-v2-body', parts);

  const expansion = source.expansion ?? DEFAULT_EXPANSION;
  const maxMemberBytes = Math.min(maxBytes, expansion.maxVersionBytes ?? MAX_VERSION_BYTES);
  let keyMissing = false;
  async function* members(): AsyncGenerator<ComposerV2Candidate> {
    const { maxVersions } = expansion;
    if (!Number.isSafeInteger(maxVersions) || maxVersions < 1) {
      throw new RangeError('maxVersions must be a positive integer');
    }
    const importedAt = isoTimestamp(options.clock.now());
    let ordinal = 0;
    for (const { form, bytes } of bodies) {
      let list: unknown[] = [];
      let current: unknown[] = [];
      let found = 0;
      let nonArray = false;
      let minified = false;
      for await (const member of extractMembers(
        chunks(bytes),
        [['packages', '*', ARRAY_ELEMENTS], ['minified']],
        { maxMemberBytes, maxDocumentBytes: maxBytes, nonArray: 'report' },
      )) {
        if (member.path[0] === 'minified') {
          minified = JSON.parse(member.raw) === 'composer/2.0';
        } else if (member.path[1]?.toLowerCase() !== key) {
          continue;
        } else if (member.end === true) {
          found++;
          list = current;
          current = [];
        } else if (member.notArray === true) {
          found++;
          nonArray = true;
        } else if (member.index !== undefined) {
          if (current.length >= maxVersions) {
            throw new ExpansionLimitError('versions', null, current.length + 1);
          }
          current.push(JSON.parse(member.raw));
        }
      }
      if (found !== 1) {
        keyMissing = true;
        continue;
      }
      if (nonArray) throw new ComposerV2Error('unsupported');
      const versions: unknown[] = minified
        ? expandVersions(list as Record<string, unknown>[], expansion)
        : list;
      for (const entry of versions) {
        const result = composerVersionInput(key, entry, { probe: options.probe, importedAt });
        if (!result.ok) {
          options.onSkip?.(result.reason);
          continue;
        }
        const { input } = result;
        yield {
          ordinal: ordinal++,
          version: input.version,
          form,
          ...(input.upstreamReleasedAt === null ? {} : { upstreamTime: input.upstreamReleasedAt }),
          raw: input.metadata.json,
          input,
          stripped: result.stripped,
        };
      }
    }
  }

  return {
    kind: 'found',
    description: createPackageDescription({
      name: key,
      snapshot: snapshotRef(snapshot),
      forms,
      members: members(),
      validators,
      documentsComplete: () => (options.dev !== true || devRecorded) && !keyMissing,
    }),
  };
}
