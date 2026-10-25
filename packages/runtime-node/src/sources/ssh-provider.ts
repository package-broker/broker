import { createHash } from 'node:crypto';
import type { OrgContext } from '@package-broker/core/db/port';
import { packageKey } from '@package-broker/core/catalogue/names';
import { normalizeVersion } from '@package-broker/core/registry/composer/version-parser';
import { UpstreamError } from '@package-broker/core/sources/policy-fetch';
import { composerVersionInput } from '@package-broker/core/registry/composer/version-object';
import {
  versionsFromRefs,
  type RefVersion,
} from '@package-broker/core/registry/composer/version-rules';
import type { VcsConfig } from '@package-broker/core/sources/config';
import {
  credentialEchoProbe,
  type CredentialEchoProbe,
  type SshKeyMaterial,
} from '@package-broker/core/sources/credentials';
import {
  createPackageDescription,
  snapshotRef,
  type ListingPage,
  type ProviderSource,
  type SnapshotRef,
  type SourceProvider,
  type VersionCandidate,
} from '@package-broker/core/sources/provider';
import type { DnsGuard } from './dns-guard.js';
import { SshArchiveStoreError } from './ssh-archive-store.js';
import {
  openSshGitSession,
  SshGitError,
  type RemoteRef,
  type SpawnGit,
  type SshGitSession,
  type SshRemote,
} from './ssh-git.js';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const SSH_URL = /^ssh:\/\/(?:([^@/:[\]]+)@)?(\[[^\]/]*\]|[^/:[\]]+)(?::(\d{1,5}))?\/(.+)$/;
const SCP_LIKE = /^(?:([^@/:[\]]+)@)?(\[[^\]/]*\]|[^/:[\]]+):(.+)$/;
const SAFE_REF = /^refs\/(?:heads|tags)\/[A-Za-z0-9._/+-]+$/;
const PLACEHOLDER_SHA1 = '0'.repeat(40);

export interface SshArchiveRecord {
  readonly sha1: string;
  readonly time: string | null;
}

export interface SshBuiltArchive extends SshArchiveRecord {
  readonly version: string;
  readonly versionNormalized: string;
  readonly commit: string;
  readonly zip: Uint8Array;
}

/**
 * Immutable archives built during SSH source ingestion, scoped per call by OrgContext.
 * Implementations must include `ctx.orgId`, source.id, canonical package name,
 * normalized version and commit in every storage key. Names are opaque key components,
 * never filesystem paths; a hash of the tuple is suitable for filesystem naming.
 *
 * `store` is the put operation. It resolves only after the complete ZIP and its SHA-1
 * and commit time are durable and atomically visible together. Readers must see either
 * no record or the complete archive, including during concurrent writes. Repeating a
 * put for an existing key preserves the first published archive; it is never rebuilt.
 *
 * `find` is the metadata get and existence check: null means absent; a record means
 * the complete ZIP is available. Storage failures reject, rather than report absence.
 * Returned records must not expose mutable internal state.
 *
 * Implementations enforce their configured ZIP byte cap before publishing. An oversized
 * archive or failed write rejects without publishing a record, preserves any prior
 * archive and removes temporary files. Errors must not contain a URL, key path or credential text.
 */
export interface SshArchiveStore {
  find(
    ctx: OrgContext,
    source: ProviderSource,
    name: string,
    versionNormalized: string,
    commit: string,
  ): Promise<SshArchiveRecord | null>;
  store(
    ctx: OrgContext,
    source: ProviderSource,
    name: string,
    archive: SshBuiltArchive,
  ): Promise<void>;
}

/** Reads only the full archive tuple; null means absent, with no upstream fallback. */
export interface SshArchiveReader extends SshArchiveStore {
  readZip(
    ctx: OrgContext,
    source: ProviderSource,
    name: string,
    versionNormalized: string,
    commit: string,
  ): Promise<Uint8Array | null>;
}

export interface SshGitProviderOptions {
  readonly dnsGuard: DnsGuard;
  readonly sshKey: (source: ProviderSource) => Promise<SshKeyMaterial>;
  readonly archives: SshArchiveReader;
  readonly tmpRoot?: string;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly spawn?: SpawnGit;
}

export function parseSshRepository(text: string): SshRemote {
  const scpForm = !text.startsWith('ssh://');
  const match = scpForm ? (text.includes('://') ? null : SCP_LIKE.exec(text)) : SSH_URL.exec(text);
  if (match) {
    const scp = scpForm;
    const user = match[1];
    const host = match[2] ?? '';
    const port = scp ? undefined : match[3];
    const path = (scp ? match[3] : match[4]) ?? '';
    if (!host.startsWith('-')) {
      return {
        host,
        ...(user === undefined ? {} : { user }),
        ...(port === undefined ? {} : { port: Number(port) }),
        path,
      };
    }
  }
  throw new SshGitError('invalid_host');
}

export function informationalUrl(remote: SshRemote): string {
  return `https://${remote.host.toLowerCase()}/${remote.path.replace(/^\/+/, '')}`;
}

function sshConfig(source: ProviderSource): VcsConfig {
  if (source.type !== 'vcs' || source.config.provider !== 'ssh') {
    throw new TypeError('the ssh provider only serves vcs sources with provider ssh');
  }
  return source.config;
}

interface RefEntry {
  readonly ref: string;
  readonly commit: string;
}

interface SelectedRefs {
  readonly tags: Map<string, RefEntry>;
  readonly branches: Map<string, RefEntry>;
  readonly snapshot: SnapshotRef;
  readonly defaultBranch: string | null;
}

function selectRefs(config: VcsConfig, refs: readonly RemoteRef[]): SelectedRefs {
  const listed = refs
    .map(
      (ref) =>
        `${ref.name} ${ref.peeled ?? ref.sha}${ref.symref === undefined ? '' : ` ${ref.symref}`}`,
    )
    .sort();
  const digest = createHash('sha256').update(listed.join('\n')).digest('hex');
  const allBranches = config.refs.branches.length === 0 || config.refs.branches.includes('*');
  const tags = new Map<string, RefEntry>();
  const branches = new Map<string, RefEntry>();
  for (const ref of refs) {
    if (!SAFE_REF.test(ref.name)) continue;
    const entry = { ref: ref.name, commit: ref.peeled ?? ref.sha };
    if (ref.name.startsWith('refs/tags/') && config.refs.tags) {
      tags.set(ref.name.slice('refs/tags/'.length), entry);
    } else if (ref.name.startsWith('refs/heads/')) {
      const branch = ref.name.slice('refs/heads/'.length);
      if (allBranches || config.refs.branches.includes(branch)) branches.set(branch, entry);
    }
  }
  const target = refs.find((ref) => ref.name === 'HEAD')?.symref;
  const defaultBranch = target?.startsWith('refs/heads/')
    ? target.slice('refs/heads/'.length)
    : null;
  return { tags, branches, snapshot: snapshotRef(`sha256:${digest}`), defaultBranch };
}

function nameOrder(selected: SelectedRefs): string[] {
  const preferred = [selected.defaultBranch, 'main', 'master'].flatMap((branch) =>
    branch === null ? [] : (selected.branches.get(branch) ?? []),
  );
  const entries = [...preferred, ...selected.branches.values(), ...selected.tags.values()];
  return [...new Set(entries.map((entry) => entry.commit))];
}

function isTooLarge(error: unknown): boolean {
  return error instanceof SshGitError && error.reason === 'output_too_large';
}

async function readManifest(
  session: SshGitSession,
  commit: string,
): Promise<Record<string, unknown> | null> {
  let bytes: Buffer;
  try {
    bytes = await session.catFile(commit, 'composer.json');
  } catch (error) {
    if (error instanceof SshGitError && error.reason === 'not_found') return null;
    throw error;
  }
  if (bytes.length > MAX_MANIFEST_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function manifestName(manifest: Record<string, unknown> | null): string | null {
  const name = manifest?.['name'];
  if (typeof name !== 'string') return null;
  try {
    return packageKey(name, { ecosystem: 'composer' });
  } catch {
    return null;
  }
}

function isDev(version: RefVersion): boolean {
  return version.kind === 'branch' || version.versionNormalized.endsWith('-dev');
}

interface Planned {
  readonly version: RefVersion;
  readonly commit: string;
  readonly manifest: Record<string, unknown>;
  record: SshArchiveRecord | null;
}

export function createSshGitProvider(options: SshGitProviderOptions): SourceProvider {
  const openSession = (
    remote: SshRemote,
    credential: SshKeyMaterial,
    maxStdoutBytes: number | undefined,
  ): Promise<SshGitSession> =>
    openSshGitSession(remote, {
      dnsGuard: options.dnsGuard,
      credential,
      ...(options.tmpRoot === undefined ? {} : { tmpRoot: options.tmpRoot }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(maxStdoutBytes === undefined ? {} : { maxStdoutBytes }),
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    });

  /** A session that hits its output limit is closed by the transport, so the walk reopens and refetches the rest. */
  async function walk(
    remote: SshRemote,
    credential: SshKeyMaterial,
    maxStdoutBytes: number | undefined,
    commits: readonly string[],
    signal: AbortSignal,
    handle: (session: SshGitSession, commit: string) => Promise<boolean>,
    tooLarge: (commit: string) => void,
  ): Promise<void> {
    let index = 0;
    while (index < commits.length) {
      const session = await openSession(remote, credential, maxStdoutBytes);
      try {
        await session.fetchRefs([...new Set(commits.slice(index))], {
          filter: 'blob:none',
          depth: 1,
        });
        while (index < commits.length) {
          signal.throwIfAborted();
          const commit = commits[index] as string;
          index += 1;
          try {
            if (await handle(session, commit)) return;
          } catch (error) {
            if (!isTooLarge(error)) throw error;
            tooLarge(commit);
            break;
          }
        }
      } finally {
        await session.close();
      }
    }
  }

  async function discover(
    remote: SshRemote,
    credential: SshKeyMaterial,
    config: VcsConfig,
  ): Promise<SelectedRefs> {
    const session = await openSession(remote, credential, options.maxStdoutBytes);
    try {
      return selectRefs(config, await session.lsRemote());
    } finally {
      await session.close();
    }
  }

  async function readManifests(
    remote: SshRemote,
    credential: SshKeyMaterial,
    commits: readonly string[],
    signal: AbortSignal,
    stopAt?: (manifest: Record<string, unknown> | null) => boolean,
  ): Promise<Map<string, Record<string, unknown> | null>> {
    const manifests = new Map<string, Record<string, unknown> | null>();
    await walk(
      remote,
      credential,
      MAX_MANIFEST_BYTES,
      commits,
      signal,
      async (session, commit) => {
        const manifest = await readManifest(session, commit);
        manifests.set(commit, manifest);
        return stopAt?.(manifest) ?? false;
      },
      (commit) => manifests.set(commit, null),
    );
    return manifests;
  }

  function firstName(
    order: readonly string[],
    manifests: Map<string, Record<string, unknown> | null>,
  ): string | null {
    for (const commit of order) {
      const name = manifestName(manifests.get(commit) ?? null);
      if (name !== null) return name;
    }
    return null;
  }

  return {
    id: 'ssh',
    sourceTypes: ['vcs'],
    ecosystems: ['composer'],

    async listPackages(ctx, source): Promise<ListingPage> {
      const config = sshConfig(source);
      const remote = parseSshRepository(config.repository);
      try {
        const credential = await options.sshKey(source);
        const selected = await discover(remote, credential, config);
        let name = config.packageName ?? null;
        if (name === null) {
          const order = nameOrder(selected);
          const manifests = await readManifests(
            remote,
            credential,
            order,
            ctx.signal,
            (manifest) => manifestName(manifest) !== null,
          );
          name = firstName(order, manifests);
        }
        return {
          names: name === null ? [] : [name],
          next: null,
          last: name !== null,
          snapshot: selected.snapshot,
        };
      } catch (error) {
        if (!(error instanceof SshGitError)) throw error;
        return {
          names: config.packageName === undefined ? [] : [config.packageName],
          next: null,
          last: false,
          snapshot: snapshotRef(`sha256:${createHash('sha256').digest('hex')}`),
        };
      }
    },

    async describe(ctx, source, requested) {
      const config = sshConfig(source);
      const key = packageKey(requested, { ecosystem: 'composer' });
      if (config.packageName !== undefined && config.packageName !== key) {
        return { kind: 'not_found', definitive: true };
      }
      const remote = parseSshRepository(config.repository);
      const credential = await options.sshKey(source);
      const probe: CredentialEchoProbe = credentialEchoProbe(credential);
      const importedAt = ctx.clock.now().toISOString();
      const selected = await discover(remote, credential, config);
      const { versions } = versionsFromRefs(
        [...selected.tags.keys()],
        [...selected.branches.keys()],
        selected.defaultBranch,
      );
      const commitOf = (version: RefVersion): string | undefined =>
        (version.kind === 'tag' ? selected.tags : selected.branches).get(version.ref)?.commit;
      const order = nameOrder(selected);
      const versionCommits = versions.flatMap((version) => commitOf(version) ?? []);
      const manifests = await readManifests(
        remote,
        credential,
        [...new Set([...order, ...versionCommits])],
        ctx.signal,
      );
      const name = config.packageName ?? firstName(order, manifests);
      if (name !== key) return { kind: 'not_found', definitive: name !== null };

      const check = (planned: Planned, record: SshArchiveRecord) => {
        const raw: Record<string, unknown> = {
          ...planned.manifest,
          name: key,
          version: planned.version.version,
          version_normalized: planned.version.versionNormalized,
          dist: {
            type: 'zip',
            url: informationalUrl(remote),
            reference: planned.commit,
            shasum: record.sha1,
          },
        };
        delete raw['source'];
        if (record.time === null) delete raw['time'];
        else raw['time'] = record.time;
        return composerVersionInput(key, raw, { probe, importedAt });
      };

      const plan: Planned[] = [];
      for (const version of versions) {
        ctx.signal.throwIfAborted();
        const commit = commitOf(version);
        const manifest = commit === undefined ? null : (manifests.get(commit) ?? null);
        if (commit === undefined || manifest === null || manifestName(manifest) !== key) continue;
        const record = await options.archives.find(
          ctx.org,
          source,
          key,
          version.versionNormalized,
          commit,
        );
        const planned: Planned = { version, commit, manifest, record };
        if (check(planned, record ?? { sha1: PLACEHOLDER_SHA1, time: null }).ok) plan.push(planned);
      }

      let incomplete = false;
      const pending = plan.filter((planned) => planned.record === null);
      const byCommit = new Map<string, Planned[]>();
      for (const planned of pending) {
        byCommit.set(planned.commit, [...(byCommit.get(planned.commit) ?? []), planned]);
      }
      await walk(
        remote,
        credential,
        options.maxStdoutBytes,
        [...byCommit.keys()],
        ctx.signal,
        async (session, commit) => {
          const time = (await session.commitTime(commit)).replace(/\.\d{3}Z$/, '+00:00');
          for (const planned of byCommit.get(commit) ?? []) {
            const zip = new Uint8Array(await session.archiveZip(commit));
            const built: SshBuiltArchive = {
              version: planned.version.version,
              versionNormalized: planned.version.versionNormalized,
              commit,
              zip,
              sha1: createHash('sha1').update(zip).digest('hex'),
              time,
            };
            await options.archives.store(ctx.org, source, key, built);
            planned.record = { sha1: built.sha1, time: built.time };
          }
          return false;
        },
        () => {
          incomplete = true;
        },
      );

      const candidates: VersionCandidate[] = [];
      for (const planned of plan) {
        if (planned.record === null) continue;
        const checked = check(planned, planned.record);
        if (!checked.ok) continue;
        candidates.push({
          ordinal: candidates.length,
          version: planned.version.version,
          form: isDev(planned.version) ? 'composer-p2-dev' : 'composer-p2',
          ...(planned.record.time === null ? {} : { upstreamTime: planned.record.time }),
          raw: checked.input.metadata.json,
        });
      }
      return {
        kind: 'found',
        description: createPackageDescription({
          name: key,
          snapshot: selected.snapshot,
          members: (async function* () {
            yield* candidates;
          })(),
          validators: {},
          documentsComplete: () => !incomplete,
        }),
      };
    },

    async openDist(ctx, source, target) {
      sshConfig(source);
      ctx.signal.throwIfAborted();
      if (
        target.distType !== 'zip' ||
        target.sourceRef === null ||
        !/^[0-9a-f]{40}$/.test(target.sourceRef)
      ) {
        throw new UpstreamError('refused');
      }
      let name: string;
      let version: string;
      try {
        name = packageKey(target.packageName, { ecosystem: 'composer' });
        version = normalizeVersion(target.version);
      } catch {
        throw new UpstreamError('refused');
      }
      let zip: Uint8Array | null;
      try {
        zip = await options.archives.readZip(ctx.org, source, name, version, target.sourceRef);
      } catch (error) {
        if (error instanceof SshArchiveStoreError) {
          ctx.observability.log({
            level: 'warn',
            event: 'dist.archive_store_error',
            reason_code: error.reason,
          });
          throw new UpstreamError('network');
        }
        throw error;
      }
      ctx.signal.throwIfAborted();
      if (zip === null) {
        ctx.observability.log({ level: 'warn', event: 'dist.archive_missing' });
        throw new UpstreamError('http_status', 404);
      }
      return {
        size: zip.byteLength,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(zip);
            controller.close();
          },
        }),
      };
    },
  };
}
