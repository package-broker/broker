import {
  GITHUB_API_VERSION,
  UpstreamError,
  parseCredentialMaterial,
  type GithubAppMaterial,
  type PolicyFetch,
  type UpstreamCredential,
} from '@package-broker/core/plugin';
import { createAppJwt } from './app-jwt.js';
import type { GithubAppKey } from './installation-token.js';

const API = 'https://api.github.com';
const APP_BYTES = 64 * 1024;
const LIST_BYTES = 8 * 1024 * 1024;
const DIGITS = /^[1-9][0-9]{0,19}$/;
const OPAQUE = /^[A-Za-z0-9_-]{1,128}$/;
const LOGIN = /^[A-Za-z0-9-]{1,100}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

type ErrorCode =
  'invalid_request' | 'invalid_response' | 'upstream_status' | 'unavailable' | 'timeout';
export class AppApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status?: number,
  ) {
    super(`GitHub App API ${code}`);
    this.name = 'AppApiError';
  }
}

export interface AppIdentity {
  readonly id: string;
  readonly slug: string;
  readonly owner: { readonly id: string; readonly login: string };
}
export interface AppConversion extends AppIdentity {
  readonly material: GithubAppKey & { readonly webhookSecret: string | null };
  readonly webhookSecretMissing: boolean;
}
export interface AppInstallation {
  readonly id: string;
  readonly account: { readonly id: string; readonly login: string };
  readonly targetType: 'Organization' | 'User';
  readonly repositorySelection: 'all' | 'selected';
  readonly suspendedAt: string | null;
  readonly permissions: Readonly<Record<string, string>>;
}
export interface AppHookConfig {
  readonly configured: boolean;
  readonly matchesExpectedUrl?: boolean;
}
export interface AppHookDelivery {
  readonly id: string;
  readonly guid: string;
  readonly event: string;
  readonly redelivery: boolean;
  readonly status: string;
  readonly deliveredAt: string;
  readonly statusCode: number | null;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppApiError('invalid_response');
  }
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !DIGITS.test(text)) throw new AppApiError('invalid_response');
  return text;
}
function account(value: unknown) {
  const row = record(value);
  if (typeof row.login !== 'string' || !LOGIN.test(row.login))
    throw new AppApiError('invalid_response');
  return Object.freeze({ id: id(row.id), login: row.login });
}
function identity(value: unknown): AppIdentity {
  const row = record(value);
  if (typeof row.slug !== 'string' || !/^[a-z0-9-]{1,100}$/.test(row.slug))
    throw new AppApiError('invalid_response');
  return { id: id(row.id), slug: row.slug, owner: account(row.owner) };
}
function installation(value: unknown, appId: string): AppInstallation {
  const row = record(value);
  const permissions = record(row.permissions);
  if (
    id(row.app_id) !== appId ||
    (row.target_type !== 'Organization' && row.target_type !== 'User') ||
    !Object.values(permissions).every(
      (level) => level === 'read' || level === 'write' || level === 'admin',
    ) ||
    (row.repository_selection !== 'all' && row.repository_selection !== 'selected') ||
    (row.suspended_at !== null &&
      (typeof row.suspended_at !== 'string' ||
        !TIMESTAMP.test(row.suspended_at) ||
        !Number.isFinite(Date.parse(row.suspended_at))))
  ) {
    throw new AppApiError('invalid_response');
  }
  return {
    id: id(row.id),
    account: account(row.account),
    targetType: row.target_type,
    repositorySelection: row.repository_selection,
    suspendedAt: row.suspended_at,
    permissions: Object.freeze({ ...permissions }) as Readonly<Record<string, string>>,
  };
}
function pageNumber(page: number): number {
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000)
    throw new AppApiError('invalid_request');
  return page;
}

export function createAppApi(options: {
  readonly fetch: PolicyFetch;
  readonly now?: () => number;
}) {
  async function request(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    app?: GithubAppKey,
    payload?: object,
    listing = false,
    onHeaders?: (headers: Headers) => void,
  ): Promise<unknown> {
    try {
      let credential: UpstreamCredential | undefined;
      if (app !== undefined) {
        const jwt = await createAppJwt(
          app.privateKeyPem,
          app.appId,
          Math.floor((options.now ?? Date.now)() / 1000),
        );
        credential = {
          origins: [API],
          queryParams: [],
          apply(headers, url) {
            if (url.origin === API) headers.set('authorization', `Bearer ${jwt}`);
            return { headers, url };
          },
        };
      }
      const maxBytes = listing ? LIST_BYTES : APP_BYTES;
      const response = await options.fetch({
        url: `${API}${path}`,
        method,
        purpose: 'api',
        destinations: [API],
        redirects: 'error',
        timeoutMs: 15_000,
        maxBytes,
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': GITHUB_API_VERSION,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(credential === undefined ? {} : { credential }),
        ...(payload === undefined
          ? {}
          : { body: new TextEncoder().encode(JSON.stringify(payload)) }),
      });
      if (response.status < 200 || response.status >= 300) {
        void response.body?.cancel().catch(() => undefined);
        throw new AppApiError('upstream_status', response.status);
      }
      try {
        onHeaders?.(response.headers);
      } catch (error) {
        void response.body?.cancel().catch(() => undefined);
        throw error;
      }
      if (response.body === null) throw new AppApiError('invalid_response');
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '';
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) throw new AppApiError('invalid_response');
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return JSON.parse(text, (key: string, value: unknown) =>
          key === 'client_secret' ? undefined : value,
        ) as unknown;
      } catch (error) {
        void reader.cancel().catch(() => undefined);
        if (
          error instanceof UpstreamError &&
          (error.code === 'timeout' || error.code === 'network')
        )
          throw error;
        throw new AppApiError('invalid_response');
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (error instanceof AppApiError) throw error;
      throw new AppApiError(
        error instanceof UpstreamError &&
          (error.code === 'timeout' ||
            error.code === 'network' ||
            error.reason === 'redirect_refused')
          ? 'timeout'
          : 'unavailable',
      );
    }
  }
  return {
    async convertManifest(code: string, expectedOwnerLogin: string): Promise<AppConversion> {
      if (
        typeof code !== 'string' ||
        !OPAQUE.test(code) ||
        typeof expectedOwnerLogin !== 'string' ||
        !LOGIN.test(expectedOwnerLogin)
      )
        throw new AppApiError('invalid_request');
      const row = record(
        await request(`/app-manifests/${encodeURIComponent(code)}/conversions`, 'POST'),
      );
      const app = identity(row);
      if (
        record(row.owner).type !== 'Organization' ||
        app.owner.login.toLowerCase() !== expectedOwnerLogin.toLowerCase()
      )
        throw new AppApiError('invalid_response');
      const missing = row.webhook_secret === null;
      let material: GithubAppMaterial;
      try {
        material = parseCredentialMaterial(
          'github_app',
          JSON.stringify({
            appId: app.id,
            privateKeyPem: row.pem,
            webhookSecret: missing ? 'pending-webhook-secret' : row.webhook_secret,
          }),
        ) as GithubAppMaterial;
      } catch {
        throw new AppApiError('invalid_response');
      }
      const secrets = {};
      Object.defineProperties(secrets, {
        appId: { value: material.appId },
        privateKeyPem: { value: material.privateKeyPem },
        webhookSecret: { value: missing ? null : material.webhookSecret },
        toJSON: { value: () => '[redacted]' },
        toString: { value: () => '[redacted]' },
        [INSPECT]: { value: () => '[redacted]' },
      });
      const result = { ...app, webhookSecretMissing: missing };
      Object.defineProperties(result, {
        material: { value: Object.freeze(secrets), enumerable: false },
        toJSON: { value: () => '[redacted GitHub App conversion]' },
        toString: { value: () => '[redacted GitHub App conversion]' },
        [INSPECT]: { value: () => '[redacted GitHub App conversion]' },
      });
      return Object.freeze(result) as AppConversion;
    },
    async getApp(app: GithubAppKey): Promise<AppIdentity> {
      const result = identity(await request('/app', 'GET', app));
      if (result.id !== app.appId) throw new AppApiError('invalid_response');
      return result;
    },
    async listInstallations(
      app: GithubAppKey,
      page = 1,
    ): Promise<{
      readonly installations: readonly AppInstallation[];
      readonly hasNext: boolean;
    }> {
      let hasNext = false;
      const rows = await request(
        `/app/installations?per_page=100&page=${pageNumber(page)}`,
        'GET',
        app,
        undefined,
        true,
        (headers) => {
          const next = nextPage(headers, '/app/installations');
          if (next === null) return;
          const value = next.searchParams.get('page');
          if (
            value === null ||
            !DIGITS.test(value) ||
            Number(value) !== page + 1 ||
            Number(value) > 1_000_000
          )
            throw new AppApiError('invalid_response');
          hasNext = true;
        },
      );
      if (!Array.isArray(rows) || rows.length > 100) throw new AppApiError('invalid_response');
      return { installations: rows.map((row) => installation(row, app.appId)), hasNext };
    },
    async getInstallation(app: GithubAppKey, installationId: string): Promise<AppInstallation> {
      if (typeof installationId !== 'string' || !DIGITS.test(installationId))
        throw new AppApiError('invalid_request');
      return installation(
        await request(`/app/installations/${installationId}`, 'GET', app),
        app.appId,
      );
    },
    async getHookConfig(app: GithubAppKey, expectedUrl?: string): Promise<AppHookConfig> {
      if (expectedUrl !== undefined) {
        try {
          if (!expectedUrl.startsWith('https://') || new URL(expectedUrl).protocol !== 'https:')
            throw new Error();
        } catch {
          throw new AppApiError('invalid_request');
        }
      }
      const row = record(await request('/app/hook/config', 'GET', app));
      return {
        ...hookConfig(row),
        ...(expectedUrl === undefined ? {} : { matchesExpectedUrl: row.url === expectedUrl }),
      };
    },
    async updateHookConfig(app: GithubAppKey, secret: string): Promise<AppHookConfig> {
      if (
        typeof secret !== 'string' ||
        secret.length < 8 ||
        secret.length > 1024 ||
        /[\r\n]/.test(secret)
      )
        throw new AppApiError('invalid_request');
      return hookConfig(record(await request('/app/hook/config', 'PATCH', app, { secret })));
    },
    async listHookDeliveries(
      app: GithubAppKey,
      cursor?: string,
    ): Promise<{
      readonly deliveries: readonly AppHookDelivery[];
      readonly nextCursor: string | null;
    }> {
      if (cursor !== undefined && (typeof cursor !== 'string' || !OPAQUE.test(cursor)))
        throw new AppApiError('invalid_request');
      let nextCursor: string | null = null;
      const rows = await request(
        `/app/hook/deliveries?per_page=100${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
        'GET',
        app,
        undefined,
        true,
        (headers) => {
          const url = nextPage(headers, '/app/hook/deliveries');
          if (url === null) return;
          const value = url.searchParams.get('cursor');
          if (value === null || !OPAQUE.test(value)) throw new AppApiError('invalid_response');
          nextCursor = value;
        },
      );
      if (!Array.isArray(rows) || rows.length > 100) throw new AppApiError('invalid_response');
      const deliveries = rows.map((value) => {
        const row = record(value);
        if (
          typeof row.guid !== 'string' ||
          !/^[A-Za-z0-9-]{1,64}$/.test(row.guid) ||
          typeof row.event !== 'string' ||
          !/^[a-z_.]{1,64}$/.test(row.event) ||
          typeof row.redelivery !== 'boolean' ||
          typeof row.status !== 'string' ||
          !/^[\x20-\x7e]{1,64}$/.test(row.status) ||
          typeof row.delivered_at !== 'string' ||
          !TIMESTAMP.test(row.delivered_at) ||
          !Number.isFinite(Date.parse(row.delivered_at)) ||
          (row.status_code !== null &&
            (!Number.isInteger(row.status_code) ||
              Number(row.status_code) < 0 ||
              Number(row.status_code) > 599))
        )
          throw new AppApiError('invalid_response');
        return {
          id: id(row.id),
          guid: row.guid,
          event: row.event,
          redelivery: row.redelivery,
          status: row.status,
          deliveredAt: row.delivered_at,
          statusCode: row.status_code as number | null,
        };
      });
      return { deliveries, nextCursor };
    },
  };
}

function hookConfig(row: Record<string, unknown>): AppHookConfig {
  if (typeof row.url !== 'string') throw new AppApiError('invalid_response');
  return { configured: row.url.length > 0 };
}

function nextPage(headers: Headers, path: string): URL | null {
  const next = headers
    .get('link')
    ?.split(',')
    .find((part) => /;\s*rel="next"/.test(part));
  if (next === undefined) return null;
  const target = /^\s*<([^>]+)>/.exec(next)?.[1];
  let url: URL;
  try {
    if (target === undefined) throw new Error();
    url = new URL(target);
  } catch {
    throw new AppApiError('invalid_response');
  }
  if (url.origin !== API || url.pathname !== path) throw new AppApiError('invalid_response');
  return url;
}
