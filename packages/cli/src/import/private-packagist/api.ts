import { createHmac, randomUUID } from 'node:crypto';

const ORIGIN = 'https://packagist.com';
export const MAX_PAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PAGES = 10_000;
export const MAX_OBJECTS = 200_000;
const ERROR_TEXT = {
  get_only: 'Private Packagist requests must use GET.',
  invalid_url: 'Private Packagist request URL refused.',
  invalid_response: 'Invalid Private Packagist response.',
  snapshot_limit_exceeded: 'Private Packagist snapshot limit exceeded.',
  clock_skew: 'Check the local clock before retrying Private Packagist.',
  packagist_auth: 'Private Packagist authentication failed.',
  packagist_signature: 'Private Packagist signature failed.',
  packagist_request: 'Private Packagist request failed.',
  redirect_refused: 'Private Packagist redirect refused.',
  org_mismatch: 'Private Packagist organization does not match.',
  org_unverified: 'Private Packagist organization could not be verified.',
  invalid_input: 'Invalid Private Packagist fetch options.',
  credential_file: 'Credential files must be regular files with mode 0600 or stricter.',
  ambiguous_credentials: 'Choose either a credential file flag or its environment variable.',
  output_exists: 'Snapshot output already exists.',
  output_unwritable: 'Snapshot output could not be written.',
} as const;

export class PackagistError extends Error {
  constructor(readonly code: keyof typeof ERROR_TEXT) {
    super(ERROR_TEXT[code]);
    this.name = 'PackagistError';
  }
}

export interface ApiOptions {
  readonly key: string;
  readonly secret: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly limits?: { readonly pages?: number; readonly objects?: number; readonly bytes?: number };
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function query(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${encode(key)}=${encode(params[key]!)}`)
    .join('&');
}

function pinnedUrl(path: string, base = ORIGIN): URL {
  try {
    const url = new URL(path, base);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash) throw new Error();
    return url;
  } catch {
    throw new PackagistError('invalid_url');
  }
}

function authorization(url: URL, key: string, secret: string, timestamp: number): string {
  const params = Object.create(null) as Record<string, string>;
  for (const [name, value] of url.searchParams) {
    // PHP parse_str rewrites these keys; our read endpoints use scalar, unique keys only.
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || Object.hasOwn(params, name))
      throw new PackagistError('invalid_url');
    params[name] = value;
  }
  const cnonce = randomUUID();
  const canonical = `GET\n${url.hostname}\n${url.pathname}\n${query({
    timestamp: String(timestamp),
    cnonce,
    key,
    version: '2',
    query: query(params),
  })}`;
  const signature = createHmac('sha256', secret).update(canonical).digest('base64');
  return `PACKAGIST-HMAC-SHA256 Key=${key}, Timestamp=${timestamp}, Cnonce=${cnonce}, Version=2, Signature=${signature}`;
}

function nextLink(header: string | null, base: string): string | null {
  if (!header) return null;
  let next: string | null = null;
  for (const part of header.split(/,(?=\s*<)/)) {
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/i.exec(part);
    if (!(rel?.[1] ?? rel?.[2] ?? '').split(/\s+/).includes('next')) continue;
    const target = /^\s*<([^>]+)>/.exec(part)?.[1];
    if (!target || next !== null) throw new PackagistError('invalid_response');
    next = pinnedUrl(target, base).href;
  }
  return next;
}

function checkDepth(value: unknown, depth = 0): void {
  if (depth > 64) throw new PackagistError('invalid_response');
  if (typeof value === 'object' && value !== null)
    for (const child of Object.values(value)) checkDepth(child, depth + 1);
}

export class PackagistApi {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ApiOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if (!/^[a-zA-Z0-9_-]+$/.test(options.key) || !options.secret || /[\r\n]/.test(options.secret))
      throw new PackagistError('invalid_input');
  }

  assertNoCredentials(value: unknown): void {
    const text = JSON.stringify(value);
    if (text.includes(this.options.key) || text.includes(this.options.secret))
      throw new PackagistError('invalid_response');
  }

  private async slot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= 2) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.active++;
    try {
      return await operation();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async body(response: Response): Promise<string> {
    const cap = Math.min(this.options.limits?.bytes ?? MAX_PAGE_BYTES, MAX_PAGE_BYTES);
    if (Number(response.headers.get('content-length')) > cap) {
      await response.body?.cancel().catch(() => undefined);
      throw new PackagistError('snapshot_limit_exceeded');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new PackagistError('invalid_response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > cap) throw new PackagistError('snapshot_limit_exceeded');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async request(path: string, method = 'GET'): Promise<{ data: unknown; next: string | null }> {
    if (method !== 'GET') throw new PackagistError('get_only');
    const url = pinnedUrl(path);
    return this.slot(async () => {
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          const response = await this.fetcher(url.href, {
            method: 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(30_000),
            headers: {
              Authorization: authorization(
                url,
                this.options.key,
                this.options.secret,
                Math.floor(this.now() / 1000),
              ),
            },
          });
          if (response.redirected || (response.status >= 300 && response.status < 400)) {
            await response.body?.cancel().catch(() => undefined);
            throw new PackagistError('redirect_refused');
          }
          if (response.status === 401) {
            await response.body?.cancel().catch(() => undefined);
            throw new PackagistError('packagist_auth');
          }
          if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
            await response.body?.cancel().catch(() => undefined);
            if (attempt === 4) throw new PackagistError('packagist_request');
            const retry = response.headers.get('retry-after');
            const retryMs =
              retry === null
                ? 0
                : /^\d+(?:\.\d+)?$/.test(retry)
                  ? Number(retry) * 1000
                  : Date.parse(retry) - this.now();
            const backoff = 1000 * 2 ** attempt + (this.options.random ?? Math.random)() * 500;
            await this.sleep(
              Math.min(30_000, Math.max(backoff, Number.isFinite(retryMs) ? retryMs : 0)),
            );
            continue;
          }
          const text = await this.body(response);
          if (response.status === 400)
            throw new PackagistError(
              /timestamp/i.test(text) ? 'clock_skew' : 'packagist_signature',
            );
          if (!response.ok) throw new PackagistError('packagist_request');
          let data: unknown;
          try {
            data = JSON.parse(text);
          } catch {
            throw new PackagistError('invalid_response');
          }
          checkDepth(data);
          return { data, next: nextLink(response.headers.get('link'), url.href) };
        }
        throw new PackagistError('packagist_request');
      } catch (error) {
        throw error instanceof PackagistError ? error : new PackagistError('packagist_request');
      }
    });
  }

  async list(path: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    let next: string | null = pinnedUrl(path).href;
    let pages = 0;
    while (next !== null) {
      if (++pages > Math.min(this.options.limits?.pages ?? MAX_PAGES, MAX_PAGES))
        throw new PackagistError('snapshot_limit_exceeded');
      const url = pinnedUrl(next);
      url.searchParams.set('limit', '500');
      const page = await this.request(url.href);
      if (!Array.isArray(page.data)) throw new PackagistError('invalid_response');
      if (
        rows.length + page.data.length >
        Math.min(this.options.limits?.objects ?? MAX_OBJECTS, MAX_OBJECTS)
      )
        throw new PackagistError('snapshot_limit_exceeded');
      for (const row of page.data) rows.push(row);
      next = page.next;
    }
    return rows;
  }
}
