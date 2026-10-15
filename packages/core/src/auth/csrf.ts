import { constantTimeEqual, sha256Hex } from './primitives.js';

export type CsrfReason =
  'cross_site' | 'origin_mismatch' | 'origin_missing' | 'token_missing' | 'token_mismatch';

export class CsrfError extends Error {
  readonly reason: CsrfReason;

  constructor(reason: CsrfReason) {
    super(reason);
    this.name = 'CsrfError';
    this.reason = reason;
  }
}

export const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CSRF_HASH_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

function assertPublicOrigin(publicOrigin: string): void {
  if (publicOrigin === 'null' || publicOrigin !== new URL(publicOrigin).origin) {
    throw new TypeError('publicOrigin must be a canonical origin');
  }
}

export function assertSameOrigin(request: Request, publicOrigin: string): void {
  assertPublicOrigin(publicOrigin);
  if (SAFE_METHODS.has(request.method.toUpperCase())) {
    return;
  }
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (origin !== null && origin !== publicOrigin) {
    throw new CsrfError('origin_mismatch');
  }
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    throw new CsrfError('cross_site');
  }
  if (origin === null && site === null) {
    throw new CsrfError('origin_missing');
  }
}

export async function assertCsrfToken(request: Request, csrfHash: string): Promise<void> {
  const token = request.headers.get('x-csrf-token');
  if (token === null || !CSRF_TOKEN_PATTERN.test(token)) {
    throw new CsrfError('token_missing');
  }
  if (!CSRF_HASH_PATTERN.test(csrfHash)) {
    throw new CsrfError('token_mismatch');
  }
  if (!constantTimeEqual(await sha256Hex(token), csrfHash)) {
    throw new CsrfError('token_mismatch');
  }
}
