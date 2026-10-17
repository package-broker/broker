import { packageKey } from '../../catalogue/names.js';
import { composerVersionInput } from '../../registry/composer/version-object.js';
import {
  credentialEchoProbe,
  parseCredentialMaterial,
  type CredentialEchoProbe,
} from '../../sources/credentials.js';
import { versionsFromRefs } from '../../registry/composer/version-rules.js';
import {
  MAX_ATTRIBUTES_FILE_BYTES,
  buildZipFromTree,
  type ArchiveStaging,
  type BuiltArchive,
} from '../../sources/git/archive.js';
import { ExportIgnore } from '../../sources/git/export-ignore.js';
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
  /**
   * Builds the zip of one commit into a staged temporary file. The caller stores it with
   * `refetchable = false` and publishes `sha1`; the bytes are never rebuilt.
   */
  buildArchive(ctx: ProviderContext, source: ProviderSource, commit: string): Promise<BuiltArchive>;
}

const SHA = /^[a-f0-9]{40}$/;
const TAGS = 'refs/tags/';
const HEADS = 'refs/heads/';
const ATTRIBUTES_FILE = '.gitattributes';

function isFetchFailure(error: unknown): error is GitFetchError | GitRemoteError | UpstreamError {
  return (
    error instanceof GitFetchError ||
    error instanceof GitRemoteError ||
    error instanceof UpstreamError
  );
}

function repository(source: ProviderSource) {
  if (
    source.type !== 'vcs' ||
    source.config.provider !== 'git' ||
    source.ecosystem !== 'composer'
  ) {
    throw new GitProviderError('invalid_request');
  }
  return { config: source.config, url: source.config.repository };
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

export function createGitProvider(options: GitProviderOptions): GitProvider {
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
    if (configured !== undefined) return keyOf(configured);
    if (s.defaultBranch === null) throw new GitProviderError('no_default_branch');
    const branch = s.listing.refs.find((ref) => ref.name === `${HEADS}${s.defaultBranch}`);
    if (branch === undefined) throw new GitProviderError('no_default_branch');
    const [file] = await readFileAtRefs(s.git, s.url, [branch], 'composer.json');
    return manifestName(file);
  }

  return {
    id: 'git',
    sourceTypes: ['vcs'],
    ecosystems: ['composer'],

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
      const wanted = keyOf(name);
      if (wanted === null) return { kind: 'not_found', definitive: true };
      const canonical = await canonicalName(s);
      if (canonical === null) return { kind: 'not_found', definitive: false };
      if (canonical !== wanted) {
        return { kind: 'not_found', definitive: true };
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
              const isolate = async (refs: typeof unread): Promise<void> => {
                ctx.signal.throwIfAborted();
                try {
                  await read(refs);
                  succeeded = true;
                } catch (error) {
                  ctx.signal.throwIfAborted();
                  if (!isFetchFailure(error)) throw error;
                  if (refs.length > 1 && !(error instanceof UpstreamError)) {
                    const middle = Math.floor(refs.length / 2);
                    await isolate(refs.slice(0, middle));
                    await isolate(refs.slice(middle));
                  } else {
                    fail(refs, error);
                  }
                }
              };
              const middle = Math.floor(unread.length / 2);
              await isolate(unread.slice(0, middle));
              await isolate(unread.slice(middle));
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

    async openDist() {
      throw new GitProviderError('not_refetchable');
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
      const capabilities = await discoverCapabilities(
        base.git.policyFetch,
        base.url,
        base.git.credential,
      );
      const { git, url } = fetchContext(ctx, options, repo.url, capabilities);
      const tree = await readTreeAtCommit(git, url, commit);
      const blobs = createGitBlobReader(git, url, await blobPlan(git, url, tree.entries));
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
const attributesDecoder = new TextDecoder();

/**
 * Blobs the archive reads: everything except export-ignored paths, plus the attribute files the
 * archive builder loads itself. Any failure while evaluating the rules returns the full plan so
 * the archive build reports it.
 */
async function blobPlan(
  git: GitFetchContext,
  url: string,
  entries: readonly GitTreeEntry[],
): Promise<string[]> {
  const blobs = entries.filter((entry) => entry.type === 'blob');
  const sources = blobs
    .filter(
      (entry) =>
        ARCHIVED_MODES.has(entry.mode) &&
        (entry.path === ATTRIBUTES_FILE || entry.path.endsWith(`/${ATTRIBUTES_FILE}`)),
    )
    .map((entry) => ({ entry, dir: entry.path.slice(0, -(ATTRIBUTES_FILE.length + 1)) }))
    .sort((a, b) => depth(a.dir) - depth(b.dir));
  const full = blobs.map((entry) => entry.oid);
  if (sources.length === 0) return full;
  try {
    const rules = new ExportIgnore();
    const loaded = new Set<string>();
    for (const { entry, dir } of sources) {
      if (dir !== '' && rules.dirIgnored(dir)) continue;
      const reader = createGitBlobReader(git, url, [entry.oid]);
      const { body } = await reader.read(entry.oid, MAX_ATTRIBUTES_FILE_BYTES);
      rules.add(dir, attributesDecoder.decode(await new Response(body).arrayBuffer()));
      loaded.add(entry.path);
    }
    return blobs
      .filter((entry) => loaded.has(entry.path) || !rules.ignored(entry.path))
      .map((entry) => entry.oid);
  } catch {
    return full;
  }
}

function depth(dir: string): number {
  return dir === '' ? 0 : dir.split('/').length;
}

function unreadableReason(file: FileAtRef | undefined): string | undefined {
  if (file === undefined) return 'missing';
  return file.reason ?? (parseManifest(file) === undefined ? 'bad_manifest' : undefined);
}

function manifestName(file: FileAtRef | undefined): string | null {
  const manifest = file === undefined ? undefined : parseManifest(file);
  return manifest === undefined ? null : keyOf(manifest.name);
}
