import {
  GITHUB_API_VERSION,
  type PolicyFetch,
  type UpstreamCredential,
} from '@package-broker/core/plugin';
import { createAppJwt } from './app-jwt.js';

export type InstallationTokenErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'unprocessable'
  | 'rate_limited'
  | 'upstream_status'
  | 'invalid_response';

const MESSAGES: Record<InstallationTokenErrorCode, string> = {
  invalid_request: 'Installation token request is invalid',
  unauthorized: 'GitHub rejected the App credentials',
  forbidden: 'GitHub refused the installation token request',
  not_found: 'GitHub installation or repository was not found',
  unprocessable: 'GitHub could not narrow the token to the requested repositories',
  rate_limited: 'GitHub rate-limited the installation token request',
  upstream_status: 'GitHub returned an unexpected status for the installation token request',
  invalid_response: 'GitHub returned an unusable installation token response',
};

const STATUS_CODES: ReadonlyMap<number, InstallationTokenErrorCode> = new Map([
  [401, 'unauthorized'],
  [403, 'forbidden'],
  [404, 'not_found'],
  [422, 'unprocessable'],
]);

export interface RateLimit {
  readonly limit: number;
  readonly remaining: number;
  readonly reset: number;
}

export class InstallationTokenError extends Error {
  readonly code: InstallationTokenErrorCode;
  readonly status: number | undefined;
  readonly rateLimit: RateLimit | undefined;
  readonly retryAfter: number | undefined;

  constructor(
    code: InstallationTokenErrorCode,
    status?: number,
    backOff: { readonly rateLimit?: RateLimit; readonly retryAfter?: number } = {},
  ) {
    super(status === undefined ? MESSAGES[code] : `${MESSAGES[code]} (${status})`);
    this.name = 'InstallationTokenError';
    this.code = code;
    this.status = status;
    this.rateLimit = backOff.rateLimit;
    this.retryAfter = backOff.retryAfter;
  }
}

export interface InstallationToken {
  readonly value: string;
  readonly expiresAt: number;
  readonly repositories: readonly string[] | null;
}

export interface GithubAppKey {
  readonly appId: string;
  readonly privateKeyPem: string;
}

export interface InstallationTokensOptions {
  readonly app: GithubAppKey;
  readonly fetch: PolicyFetch;
  readonly now?: () => number;
  readonly apiOrigin?: string;
  readonly timeoutMs?: number;
}

export interface InstallationTokens {
  forRepositories(
    installationId: string,
    repositories: readonly string[],
  ): Promise<InstallationToken>;
  forListing(installationId: string): Promise<InstallationToken>;
  observe(installationId: string, headers: Headers): void;
  rateLimit(installationId: string): RateLimit | undefined;
}

const REFRESH_MARGIN_MS = 10 * 60_000;
const MAX_LIFETIME_MS = 60 * 60_000;
const MAX_REPOSITORIES = 500;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RATE_LIMIT_ENTRIES = 1024;
const INSTALLATION_ID = /^[1-9][0-9]{0,19}$/;
const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const TOKEN_VALUE = /^[\x21-\x7e]{8,1024}$/;
const UNSIGNED = /^\d{1,15}$/;
const REDACTED = '[redacted installation token]';
const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const encoder = new TextEncoder();

export function parseRateLimit(headers: Headers): RateLimit | undefined {
  const values = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'].map((name) =>
    headers.get(name)?.trim(),
  );
  if (!values.every((value) => value !== undefined && UNSIGNED.test(value))) return undefined;
  const [limit, remaining, reset] = values.map(Number) as [number, number, number];
  return { limit, remaining, reset };
}

function redactedToken(value: string, expiresAt: number, repositories: readonly string[] | null) {
  const token = { expiresAt, repositories };
  Object.defineProperties(token, {
    value: { value, enumerable: false },
    toJSON: { value: () => ({ expiresAt, repositories, value: REDACTED }), enumerable: false },
    toString: { value: () => REDACTED, enumerable: false },
    [INSPECT]: { value: () => `InstallationToken ${REDACTED}`, enumerable: false },
  });
  return Object.freeze(token) as InstallationToken;
}

async function readJson(body: ReadableStream<Uint8Array> | null): Promise<unknown> {
  if (body === null) return undefined;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function normaliseOrigin(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new InstallationTokenError('invalid_request');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    !/^https?:\/\/[^/?#]+\/?$/i.test(text.trim())
  ) {
    throw new InstallationTokenError('invalid_request');
  }
  return url.origin;
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const value = headers.get('retry-after')?.trim();
  return value !== undefined && UNSIGNED.test(value) ? Number(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function grantMatches(
  record: Record<string, unknown>,
  requested: Readonly<Record<string, string>>,
  repositories: readonly string[] | null,
): boolean {
  const permissions = record.permissions;
  if (!isRecord(permissions)) return false;
  for (const [name, level] of Object.entries(permissions)) {
    if (!(name in requested) || level !== 'read') return false;
  }
  if (repositories === null) return true;
  const granted = record.repositories;
  if (!Array.isArray(granted)) return false;
  const names = new Set<string>();
  for (const entry of granted) {
    if (!isRecord(entry) || typeof entry.name !== 'string') return false;
    names.add(entry.name.toLowerCase());
  }
  return names.size === repositories.length && repositories.every((name) => names.has(name));
}

export function createInstallationTokens(options: InstallationTokensOptions): InstallationTokens {
  const { app, fetch } = options;
  const now = options.now ?? Date.now;
  const apiOrigin = normaliseOrigin(options.apiOrigin ?? 'https://api.github.com');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const tokens = new Map<string, InstallationToken>();
  const inflight = new Map<string, Promise<InstallationToken>>();
  const limits = new Map<string, RateLimit>();

  function remember(installationId: string, rateLimit: RateLimit | undefined): void {
    if (rateLimit === undefined) return;
    limits.delete(installationId);
    if (limits.size >= MAX_RATE_LIMIT_ENTRIES) {
      const oldest = limits.keys().next().value;
      if (oldest !== undefined) limits.delete(oldest);
    }
    limits.set(installationId, rateLimit);
  }

  function bearer(jwt: string): UpstreamCredential {
    return {
      origins: [apiOrigin],
      queryParams: [],
      apply(headers, url) {
        if (url.origin === apiOrigin) headers.set('authorization', `Bearer ${jwt}`);
        return { headers, url };
      },
    };
  }

  async function mint(
    installationId: string,
    repositories: readonly string[] | null,
  ): Promise<InstallationToken> {
    const permissions: Readonly<Record<string, string>> =
      repositories === null ? { metadata: 'read' } : { contents: 'read', metadata: 'read' };
    const payload = repositories === null ? { permissions } : { repositories, permissions };
    const jwt = await createAppJwt(app.privateKeyPem, app.appId, Math.floor(now() / 1000));
    const response = await fetch({
      url: `${apiOrigin}/app/installations/${installationId}/access_tokens`,
      method: 'POST',
      purpose: 'api',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': GITHUB_API_VERSION,
        'content-type': 'application/json',
      },
      body: encoder.encode(JSON.stringify(payload)),
      credential: bearer(jwt),
      destinations: [apiOrigin],
      maxBytes: MAX_RESPONSE_BYTES,
      timeoutMs,
    });
    const rateLimit = parseRateLimit(response.headers);
    if (response.status !== 201 && response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      const retryAfter = retryAfterSeconds(response.headers);
      const limited =
        response.status === 429 ||
        (response.status === 403 && (retryAfter !== undefined || rateLimit?.remaining === 0));
      const code = limited
        ? 'rate_limited'
        : (STATUS_CODES.get(response.status) ?? 'upstream_status');
      throw new InstallationTokenError(code, response.status, {
        ...(rateLimit === undefined ? {} : { rateLimit }),
        ...(retryAfter === undefined ? {} : { retryAfter }),
      });
    }
    remember(installationId, rateLimit);
    const parsed = await readJson(response.body);
    const receivedAt = now();
    const record = isRecord(parsed) ? parsed : {};
    const value = record.token;
    const expiry = record.expires_at;
    const expiresAt = Math.min(
      typeof expiry === 'string' ? Date.parse(expiry) : Number.NaN,
      receivedAt + MAX_LIFETIME_MS,
    );
    if (
      typeof value !== 'string' ||
      !TOKEN_VALUE.test(value) ||
      !(expiresAt - REFRESH_MARGIN_MS > receivedAt) ||
      !grantMatches(record, permissions, repositories)
    ) {
      throw new InstallationTokenError('invalid_response', response.status);
    }
    return redactedToken(value, expiresAt, repositories);
  }

  function fresh(token: InstallationToken): boolean {
    return now() < token.expiresAt - REFRESH_MARGIN_MS;
  }

  function lookup(
    installationId: string,
    repositories: readonly string[] | null,
  ): Promise<InstallationToken> {
    const key = `${installationId}\n${repositories === null ? '*' : repositories.join('/')}`;
    const hit = tokens.get(key);
    if (hit !== undefined && fresh(hit)) return Promise.resolve(hit);
    for (const [other, token] of tokens) if (!fresh(token)) tokens.delete(other);
    const running = inflight.get(key);
    if (running !== undefined) return running;
    const pending = mint(installationId, repositories)
      .then((token) => {
        if (fresh(token)) tokens.set(key, token);
        return token;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
  }

  function checkInstallation(installationId: string): void {
    if (typeof installationId !== 'string' || !INSTALLATION_ID.test(installationId)) {
      throw new InstallationTokenError('invalid_request');
    }
  }

  return {
    async forRepositories(installationId, repositories) {
      checkInstallation(installationId);
      if (!Array.isArray(repositories)) throw new InstallationTokenError('invalid_request');
      if (!repositories.every((name) => typeof name === 'string' && REPOSITORY_NAME.test(name))) {
        throw new InstallationTokenError('invalid_request');
      }
      const names = [...new Set(repositories.map((name) => name.toLowerCase()))].sort();
      if (
        names.length === 0 ||
        names.length > MAX_REPOSITORIES ||
        names.some((name) => name === '.' || name === '..')
      ) {
        throw new InstallationTokenError('invalid_request');
      }
      return lookup(installationId, Object.freeze(names));
    },
    async forListing(installationId) {
      checkInstallation(installationId);
      return lookup(installationId, null);
    },
    observe(installationId, headers) {
      checkInstallation(installationId);
      remember(installationId, parseRateLimit(headers));
    },
    rateLimit(installationId) {
      return limits.get(installationId);
    },
  };
}
