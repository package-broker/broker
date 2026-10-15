import type { IdentityContext } from '@package-broker/core/identity/port';

export type BoundedFetchFailure =
  'redirect' | 'status' | 'content_type' | 'too_large' | 'timeout' | 'network' | 'bad_json';

export class BoundedFetchError extends Error {
  readonly reason: BoundedFetchFailure;

  constructor(reason: BoundedFetchFailure) {
    super(reason);
    this.name = 'BoundedFetchError';
    this.reason = reason;
  }
}

export interface FetchLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const JSON_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/jwk-set+json',
]);

function isRedirect(response: Response): boolean {
  return (response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect';
}

function hasJsonContentType(response: Response): boolean {
  const value = response.headers.get('content-type');
  const essence = value?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return JSON_CONTENT_TYPES.has(essence);
}

function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

async function readBounded(
  response: Response,
  maxBytes: number,
  within: <T>(promise: Promise<T>) => Promise<T>,
): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await within(reader.read());
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw new BoundedFetchError('too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function fetchBounded(
  ctx: IdentityContext,
  request: Request,
  limits: FetchLimits,
): Promise<{ readonly status: number; readonly json: unknown }> {
  assertPositiveFinite(limits.maxBytes, 'maxBytes');
  assertPositiveFinite(limits.timeoutMs, 'timeoutMs');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  const deadline = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new BoundedFetchError('timeout')), {
      once: true,
    });
  });
  deadline.catch(() => undefined);
  const within = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, deadline]);

  try {
    let pending: Promise<Response>;
    try {
      const bounded = new Request(request, { redirect: 'manual', signal: controller.signal });
      pending = Promise.resolve(ctx.fetch(bounded));
    } catch {
      throw new BoundedFetchError('network');
    }
    let response: Response;
    try {
      response = await within(pending);
    } catch (error) {
      void pending.then(discardBody, () => undefined);
      throw error instanceof BoundedFetchError ? error : new BoundedFetchError('network');
    }
    if (isRedirect(response)) {
      discardBody(response);
      throw new BoundedFetchError('redirect');
    }
    if (response.status < 200 || response.status >= 300) {
      discardBody(response);
      throw new BoundedFetchError('status');
    }
    if (!hasJsonContentType(response)) {
      discardBody(response);
      throw new BoundedFetchError('content_type');
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBounded(response, limits.maxBytes, within);
    } catch (error) {
      throw error instanceof BoundedFetchError ? error : new BoundedFetchError('network');
    }
    try {
      return { status: response.status, json: JSON.parse(utf8.decode(bytes)) as unknown };
    } catch {
      throw new BoundedFetchError('bad_json');
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
