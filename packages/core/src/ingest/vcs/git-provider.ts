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
  type ArchiveStaging,
  type BuiltArchive,
} from '../../sources/git/archive.js';
import {
  GitFetchError,
  createGitBlobReader,
  readFileAtRefs,
  readTreeAtCommit,
  type FileAtRef,
  type GitFetchContext,
} from '../../sources/git/fetch.js';
import { lsRefs, type GitRef } from '../../sources/git/refs.js';
import type { PolicyFetch } from '../../sources/policy-fetch.js';
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
    const { git, url } = fetchContext(ctx, options, repo.url);
    const listing = await lsRefs(git.policyFetch, url, git.credential);
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
      const versions = versionsFromRefs(
        s.refs.filter((ref) => ref.name.startsWith(TAGS)).map((ref) => ref.name.slice(TAGS.length)),
        s.refs
          .filter((ref) => ref.name.startsWith(HEADS))
          .map((ref) => ref.name.slice(HEADS.length)),
        s.defaultBranch,
      );
      const refName = (kind: 'tag' | 'branch', ref: string): string =>
        `${kind === 'tag' ? TAGS : HEADS}${ref}`;
      const winning = new Set(versions.versions.map((v) => refName(v.kind, v.ref)));
      const winningRefs: GitRef[] = s.refs.filter((ref) => winning.has(ref.name));
      const files = await readFileAtRefs(s.git, s.url, winningRefs, 'composer.json');
      const byRef = new Map(files.map((file) => [file.ref, file]));
      let complete = true;
      const candidates: VersionCandidate[] = [];
      const origin = { probe: probeFor(ctx, s.url), importedAt: ctx.clock.now().toISOString() };
      for (const version of versions.versions) {
        const file = byRef.get(refName(version.kind, version.ref));
        const manifest = file === undefined ? undefined : parseManifest(file);
        const reason = !file
          ? 'missing'
          : (file.reason ??
            (manifest === undefined
              ? 'bad_manifest'
              : keyOf(manifest.name) === wanted
                ? undefined
                : 'foreign_name'));
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
      const { git, url } = fetchContext(ctx, options, repo.url);
      const tree = await readTreeAtCommit(git, url, commit);
      const blobs = createGitBlobReader(
        git,
        url,
        tree.entries.filter((entry) => entry.type === 'blob').map((entry) => entry.oid),
      );
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

function manifestName(file: FileAtRef | undefined): string | null {
  const manifest = file === undefined ? undefined : parseManifest(file);
  return manifest === undefined ? null : keyOf(manifest.name);
}
