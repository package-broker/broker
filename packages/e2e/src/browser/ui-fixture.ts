import { hotp, stepAt } from './totp.js';

export async function authCode(secret: Uint8Array, offset = 0): Promise<string> {
  for (;;) {
    const now = Date.now();
    const remaining = 30_000 - (now % 30_000);
    if (remaining >= 5_000) return hotp(secret, stepAt(now) + offset);
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

export function allowedUrl(raw: string, origins: readonly string[]): boolean {
  const url = new URL(raw);
  return (
    url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' &&
    url.username === '' &&
    url.password === '' &&
    origins.includes(url.origin)
  );
}

export interface RedirectResponse {
  status(): number;
  headers(): Record<string, string>;
  dispose(): Promise<void>;
}

export interface ForwardOptions {
  method: string;
  headers: Record<string, string>;
  data?: Buffer;
  maxRedirects: number;
}

export async function forwardRequest<T extends RedirectResponse>(
  request: { url: string; method: string; headers: Record<string, string>; data: Buffer | null },
  origins: readonly string[],
  fetch: (url: string, options: ForwardOptions) => Promise<T>,
  fulfill: (response: T) => Promise<void>,
): Promise<string | undefined> {
  let { url, method, data } = request;
  if (!allowedUrl(url, origins)) return 'request outside allowed origins';
  const headers = { ...request.headers };
  // Keep Chromium's cookie selection: the API client drops Secure cookies on HTTP 127.0.0.1.
  delete headers['host'];
  delete headers['content-length'];
  for (let hop = 0; hop <= 20; hop++) {
    const response = await fetch(url, {
      method,
      headers: { ...headers },
      ...(data === null ? {} : { data }),
      maxRedirects: 0,
    });
    try {
      const status = response.status();
      const location = response.headers()['location'];
      if (![301, 302, 303, 307, 308].includes(status) || !location) {
        await fulfill(response);
        return;
      }
      const next = new URL(location, url).href;
      if (!allowedUrl(next, origins)) return 'redirect outside allowed origins';
      if (new URL(next).origin !== new URL(url).origin) {
        delete headers['authorization'];
        delete headers['cookie'];
      }
      if (
        ((status === 301 || status === 302) && method === 'POST') ||
        (status === 303 && method !== 'GET' && method !== 'HEAD')
      ) {
        method = 'GET';
        data = null;
        delete headers['content-type'];
        delete headers['content-encoding'];
      }
      url = next;
    } finally {
      await response.dispose();
    }
  }
  return 'loopback redirect limit exceeded';
}
