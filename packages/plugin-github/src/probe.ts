import {
  GITHUB_API_VERSION,
  packageKey,
  type PolicyFetch,
  type UpstreamCredential,
} from '@package-broker/core/plugin';
import {
  InstallationTokenError,
  parseRateLimit,
  retryAfterSeconds,
  type InstallationTokens,
} from './installation-token.js';

const API = 'https://api.github.com';
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UNKNOWN = { kind: 'unknown', reason: 'ambiguous' } as const;

export interface UnknownProbe {
  readonly kind: 'unknown';
  readonly reason?: 'rate_limited' | 'access' | 'ambiguous';
  readonly retryAfterSeconds?: number;
}

function unknownError(error: unknown): UnknownProbe {
  if (error instanceof InstallationTokenError) {
    if (error.code === 'rate_limited')
      return {
        kind: 'unknown',
        reason: 'rate_limited',
        ...(error.retryAfter === undefined ? {} : { retryAfterSeconds: error.retryAfter }),
      };
    if (['not_found', 'unprocessable', 'forbidden'].includes(error.code))
      return { kind: 'unknown', reason: 'access' };
  }
  return UNKNOWN;
}

export interface ProbeOptions {
  readonly fetch: PolicyFetch;
  readonly tokens: InstallationTokens;
  readonly installationId: string;
  readonly repositoryId: number;
  /** Must come from the same listing generation as repositoryId; the probe reads by name. */
  readonly repository: string;
  readonly signal?: AbortSignal;
}

export type RootTreeProbe =
  | UnknownProbe
  | {
      readonly kind: 'complete';
      readonly treeSha: string;
      readonly rootEntries: readonly string[];
      readonly composerBlobSha: string | null;
    };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function request(
  options: ProbeOptions,
  path: string,
  maxBytes: number,
): Promise<UnknownProbe | { readonly kind: 'response'; readonly body: unknown }> {
  if (
    !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(options.repository) ||
    ['.', '..'].includes(options.repository.split('/')[1]!)
  )
    return UNKNOWN;
  const token = await options.tokens.forRepositoryIds(options.installationId, [
    options.repositoryId,
  ]);
  const credential: UpstreamCredential = {
    origins: [API],
    queryParams: [],
    apply(headers, url) {
      if (url.origin === API) headers.set('authorization', `Bearer ${token.value}`);
      return { headers, url };
    },
  };
  const response = await options.fetch({
    url: `${API}/repos/${options.repository}/git/${path}`,
    method: 'GET',
    purpose: 'api',
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': GITHUB_API_VERSION },
    credential,
    destinations: [API],
    redirects: 'error',
    maxBytes,
    timeoutMs: 30_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  options.tokens.observe(options.installationId, response.headers);
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    const retry = retryAfterSeconds(response.headers);
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (retry !== undefined || parseRateLimit(response.headers)?.remaining === 0))
    )
      return {
        kind: 'unknown',
        reason: 'rate_limited',
        ...(retry === undefined ? {} : { retryAfterSeconds: retry }),
      };
    return response.status === 403 || response.status === 404
      ? { kind: 'unknown', reason: 'access' }
      : UNKNOWN;
  }
  return { kind: 'response', body: await new Response(response.body).json() };
}

export async function probeRootTree(
  options: ProbeOptions,
  defaultBranch: string,
): Promise<RootTreeProbe> {
  try {
    if (
      defaultBranch.length === 0 ||
      defaultBranch.length > 1024 ||
      defaultBranch.split('/').some((segment) => ['', '.', '..'].includes(segment))
    )
      return UNKNOWN;
    const result = await request(
      options,
      `trees/${defaultBranch.split('/').map(encodeURIComponent).join('/')}`,
      8 * 1024 * 1024,
    );
    if (result.kind === 'unknown') return result;
    const tree = result.body;
    if (
      !record(tree) ||
      tree.truncated !== false ||
      typeof tree.sha !== 'string' ||
      !SHA.test(tree.sha) ||
      !Array.isArray(tree.tree)
    )
      return UNKNOWN;
    const entries = new Set<string>();
    let composerBlobSha: string | null = null;
    for (const entry of tree.tree) {
      if (
        !record(entry) ||
        typeof entry.path !== 'string' ||
        entry.path.length === 0 ||
        entry.path.includes('/') ||
        entries.has(entry.path) ||
        typeof entry.sha !== 'string' ||
        !SHA.test(entry.sha) ||
        !['blob', 'tree', 'commit'].includes(String(entry.type))
      )
        return UNKNOWN;
      entries.add(entry.path);
      if (entry.path === 'composer.json') {
        if (entry.type !== 'blob' || !['100644', '100755'].includes(String(entry.mode)))
          return UNKNOWN;
        composerBlobSha = entry.sha;
      }
    }
    return {
      kind: 'complete',
      treeSha: tree.sha,
      rootEntries: [...entries].sort(),
      composerBlobSha,
    };
  } catch (error) {
    return unknownError(error);
  }
}

export async function probeComposerBlob(
  options: ProbeOptions,
  blobSha: string,
): Promise<{ readonly kind: 'found'; readonly name: string } | UnknownProbe> {
  try {
    if (!SHA.test(blobSha)) return UNKNOWN;
    const result = await request(options, `blobs/${blobSha}`, 1024 * 1024);
    if (result.kind === 'unknown') return result;
    const blob = result.body;
    if (
      !record(blob) ||
      blob.sha !== blobSha ||
      blob.encoding !== 'base64' ||
      typeof blob.content !== 'string'
    )
      return UNKNOWN;
    const content = atob(blob.content.replace(/\s/g, ''));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(content, (char) => char.charCodeAt(0)),
    );
    const manifest: unknown = JSON.parse(text);
    if (!record(manifest) || typeof manifest.name !== 'string') return UNKNOWN;
    return { kind: 'found', name: packageKey(manifest.name, { ecosystem: 'composer' }) };
  } catch (error) {
    return unknownError(error);
  }
}
