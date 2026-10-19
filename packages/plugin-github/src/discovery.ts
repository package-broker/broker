import { GITHUB_API_VERSION, UpstreamError } from '@package-broker/core/plugin';
import type {
  DiscoveryCandidate as ExistingCandidate,
  PlanEntry,
  PolicyFetch,
  SkipReason,
  UpstreamCredential,
} from '@package-broker/core/plugin';
import { InstallationTokenError, type InstallationTokens } from './installation-token.js';

export const PAGE_SIZE = 49;

export type DiscoveryErrorCode =
  'invalid_request' | 'rate_limited' | 'upstream_status' | 'invalid_response';

const MESSAGES: Record<DiscoveryErrorCode, string> = {
  invalid_request: 'Discovery request is invalid',
  rate_limited: 'GitHub rate-limited the discovery request',
  upstream_status: 'GitHub returned an unexpected status during discovery',
  invalid_response: 'GitHub returned an unusable discovery response',
};

export class DiscoveryError extends Error {
  readonly code: DiscoveryErrorCode;
  readonly status: number | undefined;
  readonly retryAfter: number | undefined;

  constructor(code: DiscoveryErrorCode, status?: number, retryAfter?: number) {
    super(status === undefined ? MESSAGES[code] : `${MESSAGES[code]} (${status})`);
    this.name = 'DiscoveryError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export type DiscoveryEcosystem = 'composer' | 'npm';

export type { DiscoveryCandidate as ExistingCandidate } from '@package-broker/core/plugin';

export interface DiscoveryOptions {
  readonly tokens: InstallationTokens;
  readonly fetch: PolicyFetch;
  readonly installationId: string;
  readonly exists: (candidate: ExistingCandidate) => boolean | Promise<boolean>;
  readonly pattern?: string;
  readonly cursor?: string;
  readonly apiOrigin?: string;
  readonly timeoutMs?: number;
}

export interface PlanRepositoryOptions {
  readonly tokens: InstallationTokens;
  readonly fetch: PolicyFetch;
  readonly installationId: string;
  readonly repository: string;
  readonly exists: DiscoveryOptions['exists'];
  readonly apiOrigin?: string;
  readonly timeoutMs?: number;
}

export interface DiscoveryPage {
  readonly entries: readonly PlanEntry[];
  readonly nextCursor: string | null;
}

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LISTING_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BYTES = 4096;
const CURSOR = /^[1-9][0-9]{0,5}$/;
const PATTERN = /^[A-Za-z0-9._*?-]{1,100}$/;
const INSTALLATION_ID = /^[1-9][0-9]{0,19}$/;
const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const OWNER = /^[A-Za-z0-9-]{1,39}$/;
const UNSIGNED = /^\d{1,15}$/;
const MAX_NAME_LENGTH = 214;
const COMPOSER_NAME = /^[a-z0-9]+(?:[_.-][a-z0-9]+)*\/[a-z0-9]+(?:(?:[_.]|-{1,2})[a-z0-9]+)*$/;
const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const MISSING_REF = /^No commit found for the ref/i;
const MANIFESTS = [
  ['composer.json', 'composer'],
  ['package.json', 'npm'],
] as const;

interface Listed {
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly archived: boolean;
  readonly branch: string;
}

type Manifest =
  | { readonly kind: 'ok'; readonly name: unknown }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly reason: 'error_404' | 'error_451' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function globMatch(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  let pi = 0;
  let ni = 0;
  let star = -1;
  let mark = 0;
  while (ni < n.length) {
    if (pi < p.length && p[pi] === '*') {
      star = pi++;
      mark = ni;
    } else if (pi < p.length && (p[pi] === '?' || p[pi] === n[ni])) {
      pi++;
      ni++;
    } else if (star >= 0) {
      pi = star + 1;
      ni = ++mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

function patternMatcher(pattern: string | undefined): (name: string) => boolean {
  if (pattern === undefined) return () => true;
  return (name) => globMatch(pattern, name);
}

const BRANCH_FORBIDDEN = new Set(['~', '^', ':', '?', '*', '[', '\\']);

function validBranch(branch: string): boolean {
  if (branch.length === 0 || branch.length > 255) return false;
  for (const char of branch) {
    const code = char.codePointAt(0)!;
    if (code <= 0x20 || code === 0x7f || BRANCH_FORBIDDEN.has(char)) return false;
  }
  return !(
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.includes('@{') ||
    branch === '@' ||
    branch.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
  );
}

async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string | undefined> {
  if (body === null) return '';
  try {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof UpstreamError && error.code === 'too_large') return undefined;
    throw error;
  }
}

function parseListing(text: string | undefined): { listed: Listed[]; total: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? '');
  } catch {
    throw new DiscoveryError('invalid_response');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.repositories)) {
    throw new DiscoveryError('invalid_response');
  }
  const total = parsed.total_count;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
    throw new DiscoveryError('invalid_response');
  }
  if (parsed.repositories.length > PAGE_SIZE) throw new DiscoveryError('invalid_response');
  const listed = parsed.repositories.map((entry: unknown): Listed => {
    if (!isRecord(entry) || !isRecord(entry.owner)) throw new DiscoveryError('invalid_response');
    const { name, archived, default_branch: branch } = entry;
    const owner = entry.owner.login;
    if (
      typeof name !== 'string' ||
      !REPOSITORY_NAME.test(name) ||
      /^\.+$/.test(name) ||
      typeof owner !== 'string' ||
      !OWNER.test(owner) ||
      typeof archived !== 'boolean' ||
      typeof branch !== 'string' ||
      !validBranch(branch)
    ) {
      throw new DiscoveryError('invalid_response');
    }
    return { owner, name, fullName: `${owner}/${name}`, archived, branch };
  });
  return { listed, total };
}

function normaliseOrigin(text: string): string {
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:') throw new DiscoveryError('invalid_request');
    return url.origin;
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError('invalid_request');
  }
}

function discoveryClient(options: DiscoveryOptions | PlanRepositoryOptions) {
  const { tokens, fetch, installationId, exists } = options;
  const apiOrigin = normaliseOrigin(options.apiOrigin ?? 'https://api.github.com');
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (
    typeof installationId !== 'string' ||
    installationId.trim() !== installationId ||
    !INSTALLATION_ID.test(installationId)
  ) {
    throw new DiscoveryError('invalid_request');
  }

  function credential(value: string): UpstreamCredential {
    return {
      origins: [apiOrigin],
      queryParams: [],
      apply(headers, url) {
        if (url.origin === apiOrigin) headers.set('authorization', `Bearer ${value}`);
        return { headers, url };
      },
    };
  }

  async function request(
    url: string,
    accept: string,
    bearer: string,
    maxBytes: number,
  ): Promise<Awaited<ReturnType<PolicyFetch>>> {
    const response = await fetch({
      url,
      method: 'GET',
      purpose: 'api',
      headers: { accept, 'x-github-api-version': GITHUB_API_VERSION },
      credential: credential(bearer),
      destinations: [apiOrigin],
      maxBytes,
      timeoutMs,
    });
    tokens.observe(installationId, response.headers);
    return response;
  }

  function failure(response: Awaited<ReturnType<PolicyFetch>>): DiscoveryError {
    void response.body?.cancel().catch(() => undefined);
    const after = response.headers.get('retry-after')?.trim();
    const retryAfter = after !== undefined && UNSIGNED.test(after) ? Number(after) : undefined;
    const limited =
      response.status === 429 ||
      (response.status === 403 &&
        (retryAfter !== undefined ||
          response.headers.get('x-ratelimit-remaining')?.trim() === '0'));
    return new DiscoveryError(
      limited ? 'rate_limited' : 'upstream_status',
      response.status,
      retryAfter,
    );
  }

  async function manifest(repo: Listed, file: string, bearer: string): Promise<Manifest> {
    let response: Awaited<ReturnType<PolicyFetch>>;
    try {
      response = await request(
        `${apiOrigin}/repos/${repo.owner}/${repo.name}/contents/${file}?ref=${encodeURIComponent(repo.branch)}`,
        'application/vnd.github.raw+json',
        bearer,
        MAX_MANIFEST_BYTES,
      );
    } catch (error) {
      if (error instanceof UpstreamError && error.code === 'too_large') return { kind: 'invalid' };
      throw error;
    }
    if (response.status === 451) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: 'error', reason: 'error_451' };
    }
    if (response.status === 404) {
      const text = await readCapped(response.body, MAX_ERROR_BYTES);
      let message: unknown;
      try {
        message = (JSON.parse(text ?? '') as { message?: unknown }).message;
      } catch {
        message = undefined;
      }
      return typeof message === 'string' && MISSING_REF.test(message)
        ? { kind: 'error', reason: 'error_404' }
        : { kind: 'absent' };
    }
    if (response.status !== 200) throw failure(response);
    const text = await readCapped(response.body, MAX_MANIFEST_BYTES);
    if (text === undefined) return { kind: 'invalid' };
    try {
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) ? { kind: 'ok', name: parsed.name } : { kind: 'invalid' };
    } catch {
      return { kind: 'invalid' };
    }
  }

  async function classify(
    repository: string,
    ecosystem: DiscoveryEcosystem,
    result: Manifest,
  ): Promise<PlanEntry> {
    const name = result.kind === 'ok' ? result.name : undefined;
    const valid =
      typeof name === 'string' &&
      name.length <= MAX_NAME_LENGTH &&
      (ecosystem === 'composer' ? COMPOSER_NAME : NPM_NAME).test(name);
    if (!valid) return skipped(repository, 'invalid_name', ecosystem);
    if (ecosystem === 'npm') {
      return skipped(repository, 'npm_from_vcs_unsupported', ecosystem, name);
    }
    const present = await exists({ repository, ecosystem, packageName: name });
    return {
      repository,
      ecosystem,
      packageName: name,
      action: present ? 'existing' : 'new',
      reason: null,
    };
  }

  async function plan(repo: Listed, bearer: string): Promise<readonly PlanEntry[]> {
    if (repo.archived) return [skipped(repo.fullName, 'archived')];
    const found: PlanEntry[] = [];
    for (const [file, ecosystem] of MANIFESTS) {
      const result = await manifest(repo, file, bearer);
      if (result.kind === 'absent') continue;
      if (result.kind === 'error') {
        found.push(skipped(repo.fullName, result.reason));
        break;
      }
      found.push(await classify(repo.fullName, ecosystem, result));
    }
    return found.length > 0 ? found : [skipped(repo.fullName, 'no_manifest')];
  }

  return { apiOrigin, request, failure, plan };
}

export async function planRepository(options: PlanRepositoryOptions): Promise<PlanEntry> {
  const client = discoveryClient(options);
  if (typeof options.repository !== 'string') throw new DiscoveryError('invalid_request');
  const parts = options.repository.split('/');
  const [owner, name] = parts;
  if (
    parts.length !== 2 ||
    owner === undefined ||
    !OWNER.test(owner) ||
    owner.trim() !== owner ||
    name === undefined ||
    !REPOSITORY_NAME.test(name) ||
    name.trim() !== name ||
    /^\.+$/.test(name)
  ) {
    throw new DiscoveryError('invalid_request');
  }
  let contentsToken;
  try {
    contentsToken = await options.tokens.forRepositories(options.installationId, [name]);
  } catch (error) {
    if (
      error instanceof InstallationTokenError &&
      (error.code === 'not_found' || error.code === 'unprocessable')
    ) {
      return skipped(options.repository, 'error_404');
    }
    throw error;
  }
  const response = await client.request(
    `${client.apiOrigin}/repos/${owner}/${name}`,
    'application/vnd.github+json',
    contentsToken.value,
    MAX_LISTING_BYTES,
  );
  if (response.status === 404 || response.status === 451) {
    void response.body?.cancel().catch(() => undefined);
    return skipped(options.repository, response.status === 404 ? 'error_404' : 'error_451');
  }
  if (response.status !== 200) throw client.failure(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readCapped(response.body, MAX_LISTING_BYTES)) ?? '');
  } catch {
    throw new DiscoveryError('invalid_response');
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.archived !== 'boolean' ||
    typeof parsed.default_branch !== 'string' ||
    !validBranch(parsed.default_branch)
  ) {
    throw new DiscoveryError('invalid_response');
  }
  const entries = await client.plan(
    {
      owner,
      name,
      fullName: options.repository,
      archived: parsed.archived,
      branch: parsed.default_branch,
    },
    contentsToken.value,
  );
  return entries[0]!;
}

export async function discoverRepositories(options: DiscoveryOptions): Promise<DiscoveryPage> {
  const { tokens, installationId } = options;
  const { apiOrigin, request, failure, plan } = discoveryClient(options);
  if (options.pattern !== undefined && !PATTERN.test(options.pattern)) {
    throw new DiscoveryError('invalid_request');
  }
  if (options.cursor !== undefined && !CURSOR.test(options.cursor)) {
    throw new DiscoveryError('invalid_request');
  }
  const page = options.cursor === undefined ? 1 : Number(options.cursor);
  const matches = patternMatcher(options.pattern);

  const listingToken = await tokens.forListing(installationId);
  const listingResponse = await request(
    `${apiOrigin}/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`,
    'application/vnd.github+json',
    listingToken.value,
    MAX_LISTING_BYTES,
  );
  if (listingResponse.status !== 200) throw failure(listingResponse);
  const { listed, total } = parseListing(await readCapped(listingResponse.body, MAX_LISTING_BYTES));
  const nextCursor = page * PAGE_SIZE < total ? String(page + 1) : null;

  const entries = new Map<string, readonly PlanEntry[]>();
  const candidates: Listed[] = [];
  for (const repo of listed) {
    if (!matches(repo.name)) {
      entries.set(repo.fullName, [skipped(repo.fullName, 'filtered_out')]);
    } else if (repo.archived) {
      entries.set(repo.fullName, [skipped(repo.fullName, 'archived')]);
    } else {
      candidates.push(repo);
    }
  }

  if (candidates.length > 0) {
    const contentsToken = await tokens.forRepositories(
      installationId,
      candidates.map((repo) => repo.name),
    );

    for (const repo of candidates) {
      entries.set(repo.fullName, await plan(repo, contentsToken.value));
    }
  }

  return { entries: listed.flatMap((repo) => entries.get(repo.fullName)!), nextCursor };
}

function skipped(
  repository: string,
  reason: SkipReason,
  ecosystem: DiscoveryEcosystem | null = null,
  packageName: string | null = null,
): PlanEntry {
  return { repository, ecosystem, packageName, action: 'skipped', reason };
}
