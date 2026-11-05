import { gitTarball } from './git-tar.js';
import { npmVcsDescription, parseNpmVcsManifest } from './npm-adapter.js';
import { npmVersionsFromRefs } from '../../registry/npm/version-rules.js';
import { packageKey } from '../../catalogue/names.js';
import { composerVersionInput } from '../../registry/composer/version-object.js';
import {
  credentialEchoProbe,
  parseCredentialMaterial,
  type CredentialEchoProbe,
} from '../../sources/credentials.js';
import { versionsFromRefs } from '../../registry/composer/version-rules.js';
import {
  buildZipFromTree,
  loadAttributes,
  type ArchiveBlobSource,
  type ArchiveStaging,
  type BuiltArchive,
} from '../../sources/git/archive.js';
import {
  GitFetchError,
  createGitBlobReader,
  readFileAtRefs,
  readTreeAtCommit,
  type FileAtRef,
  type GitCapabilities,
  type GitFetchContext,
  type GitTreeEntry,
} from '../../sources/git/fetch.js';
import { discoverCapabilities, lsRefs } from '../../sources/git/refs.js';
import { UpstreamError, type PolicyFetch } from '../../sources/policy-fetch.js';
import { GitRemoteError } from '../../sources/git/pkt-line.js';
import {
  createPackageDescription,
  snapshotRef,
  type ProviderContext,
  type ProviderSource,
  type SnapshotRef,
  type SourceProvider,
  type VersionCandidate,
} from '../../sources/provider.js';

export type GitProviderErrorCode =
  'invalid_request' | 'snapshot_changed' | 'no_default_branch' | 'not_refetchable';

export class GitProviderError extends Error {
  readonly code: GitProviderErrorCode;

  constructor(code: GitProviderErrorCode) {
    super(`git provider ${code}`);
    this.name = 'GitProviderError';
    this.code = code;
  }
}

export interface GitProviderOptions {
  readonly runtime: 'docker' | 'cloudflare';
  /** Needed only by buildArchive. */
  readonly staging?: ArchiveStaging;
}

export interface GitProvider extends SourceProvider {
  /** Builds the deterministic zip of one commit into a staged temporary file. */
  buildArchive(ctx: ProviderContext, source: ProviderSource, commit: string): Promise<BuiltArchive>;
}

const SHA = /^[a-f0-9]{40}$/;
const TAGS = 'refs/tags/';
const HEADS = 'refs/heads/';

function isFetchFailure(error: unknown): error is GitFetchError | GitRemoteError | UpstreamError {
  return (
    error instanceof GitFetchError ||
    error instanceof GitRemoteError ||
    error instanceof UpstreamError
  );
}

type FetchFailure = GitFetchError | GitRemoteError | UpstreamError;

function sameFailure(a: FetchFailure, b: FetchFailure): boolean {
  return (
    a.constructor === b.constructor &&
    a.code === b.code &&
    (a instanceof UpstreamError ? a.status : undefined) ===
      (b instanceof UpstreamError ? b.status : undefined)
  );
}

function transientUpstream(error: FetchFailure): boolean {
  return (
    error instanceof UpstreamError &&
    (error.code === 'timeout' ||
      error.code === 'network' ||
      (error.code === 'http_status' && error.status === 429))
  );
}

function retryBackoff(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, 100);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function repository(source: ProviderSource) {
  if (
    source.type !== 'vcs' ||
    source.config.provider !== 'git' ||
    !['composer', 'npm'].includes(source.ecosystem)
  ) {
    throw new GitProviderError('invalid_request');
  }
  return { config: source.config, url: source.config.repository, ecosystem: source.ecosystem };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keyOf(name: string): string | null {
  try {
    return packageKey(name, { ecosystem: 'composer' });
  } catch {
    return null;
  }
}

function fetchContext(
  ctx: ProviderContext,
  options: GitProviderOptions,
  url: string,
  capabilities?: GitCapabilities,
): { git: GitFetchContext; url: string } {
  const policyFetch: PolicyFetch = (request) =>
    ctx.fetch({
      ...request,
      signal:
        request.signal === undefined ? ctx.signal : AbortSignal.any([ctx.signal, request.signal]),
    });
  return {
    url,
    git: {
      policyFetch,
      codecs: ctx.codecs,
      runtime: options.runtime,
      ...(ctx.credential === null ? {} : { credential: ctx.credential }),
      ...(capabilities === undefined ? {} : { capabilities }),
    },
  };
}

function probeFor(ctx: ProviderContext, url: string): CredentialEchoProbe {
  if (ctx.credential === null) return { secrets: [], queryParams: [] };
  const applied = ctx.credential.apply(new Headers(), new URL(url));
  const authorization = applied.headers.get('authorization');
  if (authorization?.startsWith('Bearer ') === true) {
    return credentialEchoProbe(
      parseCredentialMaterial('bearer', JSON.stringify({ token: authorization.slice(7) })),
    );
  }
  if (authorization?.startsWith('Basic ') === true) {
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(authorization.slice(6)), (char) => char.charCodeAt(0)),
    );
    const colon = decoded.indexOf(':');
    if (colon >= 0)
      return credentialEchoProbe(
        parseCredentialMaterial(
          'http_basic',
          JSON.stringify({ username: decoded.slice(0, colon), password: decoded.slice(colon + 1) }),
        ),
      );
  }
  return {
    secrets: [...applied.headers.values(), ...applied.url.searchParams.values()],
    queryParams: ctx.credential.queryParams,
  };
}

function stripContactFields(raw: Record<string, unknown>): void {
  const cleanHomepage = (object: Record<string, unknown>): void => {
    if (object.homepage === undefined) return;
    try {
      const url = new URL(String(object.homepage));
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username !== '' ||
        url.password !== '' ||
        url.search !== '' ||
        url.hash !== ''
      ) {
        delete object.homepage;
      }
    } catch {
      delete object.homepage;
    }
  };
  cleanHomepage(raw);
  if (Array.isArray(raw.authors)) {
    raw.authors = raw.authors.map((author: unknown) => {
      if (!record(author)) return author;
      const clean = { ...author };
      delete clean.email;
      cleanHomepage(clean);
      return clean;
    });
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const CAPABILITIES_TTL_MS = 5 * 60_000;
const CAPABILITIES_MAX_ENTRIES = 256;

export function createGitProvider(options: GitProviderOptions): GitProvider {
  const discovered = new Map<string, { at: number; capabilities: Promise<GitCapabilities> }>();

  function remember(
    ctx: ProviderContext,
    source: ProviderSource,
    url: string,
    capabilities: Promise<GitCapabilities>,
  ): void {
    if (discovered.size >= CAPABILITIES_MAX_ENTRIES) discovered.clear();
    const key = `${ctx.org.orgId}\0${source.id}\0${url}`;
    const entry = { at: ctx.clock.now().getTime(), capabilities };
    discovered.set(key, entry);
    capabilities.catch(() => {
      if (discovered.get(key) === entry) discovered.delete(key);
    });
  }

  function cachedCapabilities(
    ctx: ProviderContext,
    source: ProviderSource,
    url: string,
  ): Promise<GitCapabilities> | undefined {
    const entry = discovered.get(`${ctx.org.orgId}\0${source.id}\0${url}`);
    return entry !== undefined && ctx.clock.now().getTime() - entry.at < CAPABILITIES_TTL_MS
      ? entry.capabilities
      : undefined;
  }

  async function listRefs(ctx: ProviderContext, source: ProviderSource) {
    const repo = repository(source);
    const base = fetchContext(ctx, options, repo.url);
    let capabilities: GitCapabilities | undefined;
    const listing = await lsRefs(
      base.git.policyFetch,
      base.url,
      base.git.credential,
      (advertised) => {
        capabilities = advertised;
      },
    );
    if (capabilities !== undefined) remember(ctx, source, repo.url, Promise.resolve(capabilities));
    const { git, url } =
      capabilities === undefined ? base : fetchContext(ctx, options, repo.url, capabilities);
    const { config } = repo;
    const refs = listing.refs.filter(
      (ref) =>
        (config.refs.tags && ref.name.startsWith(TAGS)) ||
        (ref.name.startsWith(HEADS) && config.refs.branches.includes(ref.name.slice(HEADS.length))),
    );
    const head = listing.refs.find((ref) => ref.name === 'HEAD')?.symref;
    const defaultBranch = head?.startsWith(HEADS) === true ? head.slice(HEADS.length) : null;
    const hex = await sha256Hex(
      JSON.stringify({
        defaultBranch,
        refs: [...listing.refs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      }),
    );
    return { repo, git, url, listing, refs, defaultBranch, snapshot: snapshotRef(`sha256:${hex}`) };
  }

  function skipped(ctx: ProviderContext, reason: string): void {
    ctx.observability.counter('git_provider_ref_skipped', { reason });
  }

  async function canonicalName(s: Awaited<ReturnType<typeof listRefs>>): Promise<string | null> {
    const configured = s.repo.config.packageName;
    if (configured !== undefined)
      return s.repo.ecosystem === 'npm' ? configured : keyOf(configured);
    if (s.defaultBranch === null) throw new GitProviderError('no_default_branch');
    const branch = s.listing.refs.find((ref) => ref.name === `${HEADS}${s.defaultBranch}`);
    if (branch === undefined) throw new GitProviderError('no_default_branch');
    const [file] = await readFileAtRefs(
      s.git,
      s.url,
      [branch],
      s.repo.ecosystem === 'npm' ? 'package.json' : 'composer.json',
    );
    if (s.repo.ecosystem === 'npm') {
      try {
        const manifest = parseNpmVcsManifest(file?.text ?? '');
        return typeof manifest.name === 'string'
          ? packageKey(manifest.name, { ecosystem: 'npm' })
          : null;
      } catch {
        return null;
      }
    }
    return manifestName(file);
  }

  return {
    id: 'git',
    sourceTypes: ['vcs'],
    ecosystems: ['composer', 'npm'],

    async listPackages(ctx, source) {
      const s = await listRefs(ctx, source);
      const empty = (snapshot: SnapshotRef) => ({
        names: [],
        next: null,
        last: false,
        snapshot,
      });
      const name = await canonicalName(s);
      if (name === null) return empty(s.snapshot);
      return { names: [name], next: null, last: true, snapshot: s.snapshot };
    },

    async describe(ctx, source, name, describeOptions) {
      const s = await listRefs(ctx, source);
      if (describeOptions.snapshot !== undefined && describeOptions.snapshot.id !== s.snapshot.id) {
        throw new GitProviderError('snapshot_changed');
      }
      const wanted = source.ecosystem === 'npm' ? name : keyOf(name);
      if (wanted === null) return { kind: 'not_found', definitive: true };
      const canonical = await canonicalName(s);
      if (canonical === null) return { kind: 'not_found', definitive: false };
      if (canonical !== wanted) {
        return { kind: 'not_found', definitive: true };
      }
      if (source.ecosystem === 'npm') {
        const tags = s.refs
          .filter((ref) => ref.name.startsWith(TAGS))
          .map((ref) => ref.name.slice(TAGS.length));
        const winning = new Set(npmVersionsFromRefs(tags).versions.map((v) => `${TAGS}${v.ref}`));
        const files = await readFileAtRefs(
          s.git,
          s.url,
          s.refs.filter((ref) => winning.has(ref.name)),
          'package.json',
        );
        return {
          kind: 'found',
          description: await npmVcsDescription(
            wanted,
            s.repo.config.packageName,
            tags,
            files,
            s.snapshot,
          ),
        };
      }
      const refName = (kind: 'tag' | 'branch', ref: string): string =>
        `${kind === 'tag' ? TAGS : HEADS}${ref}`;
      const tags = s.refs
        .filter((ref) => ref.name.startsWith(TAGS))
        .map((ref) => ref.name.slice(TAGS.length));
      const branches = s.refs
        .filter((ref) => ref.name.startsWith(HEADS))
        .map((ref) => ref.name.slice(HEADS.length));
      const rank = (dead: ReadonlySet<string>) =>
        versionsFromRefs(
          tags.filter((tag) => !dead.has(`${TAGS}${tag}`)),
          branches.filter((branch) => !dead.has(`${HEADS}${branch}`)),
          s.defaultBranch,
        );
      let complete = true;
      const dead = new Set<string>();
      const files = new Map<string, FileAtRef>();
      const failures = new Map<string, string>();
      let versions = rank(dead);
      for (let round = 0; ; round++) {
        const winning = new Set(versions.versions.map((v) => refName(v.kind, v.ref)));
        const unread = s.refs.filter((ref) => winning.has(ref.name) && !files.has(ref.name));
        if (unread.length > 0) {
          const read = async (refs: typeof unread) => {
            for (const file of await readFileAtRefs(s.git, s.url, refs, 'composer.json')) {
              files.set(file.ref, file);
            }
          };
          const fail = (refs: typeof unread, error: unknown) => {
            ctx.signal.throwIfAborted();
            if (!isFetchFailure(error)) throw error;
            for (const ref of refs) failures.set(ref.name, error.code);
          };
          try {
            await read(unread);
          } catch (error) {
            ctx.signal.throwIfAborted();
            if (round === 0) {
              if (
                unread.length === 1 ||
                !(error instanceof GitFetchError || error instanceof GitRemoteError)
              ) {
                throw error;
              }
              let succeeded = false;
              const attempt = async (refs: typeof unread): Promise<FetchFailure | undefined> => {
                for (let retry = 0; ; retry++) {
                  ctx.signal.throwIfAborted();
                  try {
                    await read(refs);
                    succeeded = true;
                    return undefined;
                  } catch (failure) {
                    ctx.signal.throwIfAborted();
                    if (!isFetchFailure(failure)) throw failure;
                    if (retry > 0 || !transientUpstream(failure)) return failure;
                    await retryBackoff(ctx.signal);
                  }
                }
              };
              const isolate = async (refs: typeof unread, failure: FetchFailure): Promise<void> => {
                if (refs.length === 1 || transientUpstream(failure)) {
                  fail(refs, failure);
                  return;
                }
                const middle = Math.floor(refs.length / 2);
                const halves = [refs.slice(0, middle), refs.slice(middle)] as const;
                const failures = [await attempt(halves[0]), await attempt(halves[1])] as const;
                const [first, second] = failures;
                if (
                  refs === unread &&
                  first !== undefined &&
                  second !== undefined &&
                  !transientUpstream(first) &&
                  sameFailure(first, second)
                ) {
                  const probed = await Promise.all(
                    halves.map(async (half, n) => ({
                      ref: half[0] as (typeof half)[number],
                      failure: half.length > 1 ? await attempt(half.slice(0, 1)) : failures[n],
                    })),
                  );
                  if (probed.every((probe) => probe.failure !== undefined)) {
                    for (const probe of probed) fail([probe.ref], probe.failure);
                    const probedNames = new Set(probed.map((probe) => probe.ref.name));
                    for (const ref of refs) {
                      if (probedNames.has(ref.name)) continue;
                      const single = await attempt([ref]);
                      if (single !== undefined) fail([ref], single);
                    }
                    return;
                  }
                }
                for (const [n, half] of halves.entries()) {
                  const halfFailure = failures[n];
                  if (halfFailure !== undefined) await isolate(half, halfFailure);
                }
              };
              await isolate(unread, error);
              if (!succeeded) throw error;
            } else {
              fail(unread, error);
            }
          }
        }
        ctx.signal.throwIfAborted();
        const unreadable = [...winning].filter(
          (name) => unreadableReason(files.get(name)) !== undefined,
        );
        if (unreadable.length === 0) break;
        for (const name of unreadable) {
          dead.add(name);
          complete = false;
          skipped(ctx, failures.get(name) ?? (unreadableReason(files.get(name)) as string));
        }
        versions = rank(dead);
      }
      const candidates: VersionCandidate[] = [];
      const origin = { probe: probeFor(ctx, s.url), importedAt: ctx.clock.now().toISOString() };
      for (const version of versions.versions) {
        const file = files.get(refName(version.kind, version.ref));
        const manifest = file === undefined ? undefined : parseManifest(file);
        const reason =
          unreadableReason(file) ??
          (manifest !== undefined && keyOf(manifest.name) !== wanted ? 'foreign_name' : undefined);
        if (reason !== undefined || file === undefined || manifest === undefined) {
          complete = false;
          skipped(ctx, reason ?? 'bad_manifest');
          continue;
        }
        const raw: Record<string, unknown> = {
          ...manifest.value,
          ...(version.defaultBranch ? { 'default-branch': true } : {}),
          version: version.version,
          version_normalized: version.versionNormalized,
          source: { type: 'git', url: s.repo.url, reference: file.commit },
          dist: { type: 'zip', url: s.repo.url, reference: file.commit },
        };
        delete raw['notification-url'];
        delete raw.support;
        if (file.committedAt === null) delete raw.time;
        else raw.time = file.committedAt;
        stripContactFields(raw);
        const mapped = composerVersionInput(canonical, raw, origin);
        if (!mapped.ok) {
          complete = false;
          skipped(ctx, mapped.reason);
          continue;
        }
        candidates.push({
          ordinal: candidates.length,
          version: version.version,
          form: version.kind === 'tag' ? 'composer-p2' : 'composer-p2-dev',
          ...(file.committedAt === null ? {} : { upstreamTime: file.committedAt }),
          raw: mapped.input.metadata.json,
        });
      }
      return {
        kind: 'found',
        description: createPackageDescription({
          name: canonical,
          snapshot: s.snapshot,
          validators: {},
          documentsComplete: complete,
          members: (async function* () {
            yield* candidates;
          })(),
        }),
      };
    },

    async openDist(ctx, source, target) {
      const repo = repository(source);
      if (source.ecosystem !== 'npm') throw new GitProviderError('not_refetchable');
      if (
        target.distType !== 'tgz' ||
        target.sourceRef === null ||
        !SHA.test(target.sourceRef) ||
        target.url !== null
      )
        throw new GitProviderError('invalid_request');
      const { git, url } = fetchContext(ctx, options, repo.url);
      const tree = await readTreeAtCommit(git, url, target.sourceRef);
      const { plan, attributes } = await blobPlan(git, url, tree.entries);
      const reader = createGitBlobReader(
        git,
        url,
        plan.filter((id) => !attributes.has(id)),
      );
      return {
        size: null,
        body: await gitTarball(tree, withPreloaded(reader, attributes), ctx.codecs, ctx.signal),
      };
    },

    async buildArchive(ctx, source, commit) {
      if (options.runtime === 'cloudflare') {
        throw new GitFetchError('git_archive_requires_docker');
      }
      const repo = repository(source);
      if (!SHA.test(commit) || options.staging === undefined) {
        throw new GitProviderError('invalid_request');
      }
      const base = fetchContext(ctx, options, repo.url);
      let pending = cachedCapabilities(ctx, source, repo.url);
      if (pending === undefined) {
        pending = discoverCapabilities(base.git.policyFetch, base.url, base.git.credential);
        remember(ctx, source, repo.url, pending);
      }
      const { git, url } = fetchContext(ctx, options, repo.url, await pending);
      const tree = await readTreeAtCommit(git, url, commit);
      const { plan, attributes } = await blobPlan(git, url, tree.entries);
      const reader = createGitBlobReader(
        git,
        url,
        plan.filter((id) => !attributes.has(id)),
      );
      const blobs = attributes.size === 0 ? reader : withPreloaded(reader, attributes);
      return buildZipFromTree(tree, ctx.codecs, { blobs, staging: options.staging });
    },
  };
}

function parseManifest(
  file: FileAtRef,
): { name: string; value: Record<string, unknown> } | undefined {
  if (file.text === null || !SHA.test(file.commit)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(file.text);
  } catch {
    return undefined;
  }
  return record(value) && typeof value.name === 'string' ? { name: value.name, value } : undefined;
}

const ARCHIVED_MODES = new Set(['100644', '100755']);

/**
 * Blobs the archive reads: everything except export-ignored paths, plus the attribute files the
 * archive builder loads itself, whose bytes come back so the build does not fetch them again. Any
 * failure while evaluating the rules returns the full plan so the archive build reports it.
 */
async function blobPlan(
  git: GitFetchContext,
  url: string,
  entries: readonly GitTreeEntry[],
): Promise<{ plan: string[]; attributes: ReadonlyMap<string, Uint8Array> }> {
  const blobs = entries.filter((entry) => entry.type === 'blob');
  const full = blobs.map((entry) => entry.oid);
  const attributes = new Map<string, Uint8Array>();
  const recording: ArchiveBlobSource = {
    async read(oid, maxBytes) {
      const { size, body } = await createGitBlobReader(git, url, [oid]).read(oid, maxBytes);
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      attributes.set(oid, bytes);
      return { size, body: new Blob([bytes]).stream() };
    },
  };
  try {
    const { matcher, loaded } = await loadAttributes(
      recording,
      blobs.filter((entry) => ARCHIVED_MODES.has(entry.mode)),
      { used: 0 },
    );
    if (loaded.size === 0) return { plan: full, attributes };
    const plan = blobs.filter((entry) => !matcher.ignored(entry.path)).map((entry) => entry.oid);
    return { plan, attributes };
  } catch {
    return { plan: full, attributes };
  }
}

function withPreloaded(
  blobs: ArchiveBlobSource,
  preloaded: ReadonlyMap<string, Uint8Array>,
): ArchiveBlobSource {
  return {
    read(oid, maxBytes) {
      const bytes = preloaded.get(oid);
      return bytes === undefined
        ? blobs.read(oid, maxBytes)
        : Promise.resolve({ size: bytes.length, body: new Blob([bytes]).stream() });
    },
  };
}

function unreadableReason(file: FileAtRef | undefined): string | undefined {
  if (file === undefined) return 'missing';
  return file.reason ?? (parseManifest(file) === undefined ? 'bad_manifest' : undefined);
}

function manifestName(file: FileAtRef | undefined): string | null {
  const manifest = file === undefined ? undefined : parseManifest(file);
  return manifest === undefined ? null : keyOf(manifest.name);
}
