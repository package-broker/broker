export type PublicOriginProblem = 'missing' | 'absolute-url' | 'scheme' | 'origin';

export class PublicOriginError extends Error {
  constructor(readonly problem: PublicOriginProblem) {
    super('Invalid public origin');
    this.name = 'PublicOriginError';
  }
}

export interface PublicOriginOptions {
  /** HTTPS only by default; startup may permit loopback HTTP, kernel callers may permit HTTP. */
  readonly http?: 'deny' | 'loopback' | 'allow';
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export function parsePublicOrigin(
  raw: string | undefined,
  options: PublicOriginOptions = {},
): string {
  if (raw === undefined || raw === '') throw new PublicOriginError('missing');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PublicOriginError('absolute-url');
  }
  const httpAllowed =
    options.http === 'allow' || (options.http === 'loopback' && LOOPBACK_HOSTS.has(url.hostname));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && httpAllowed)) {
    throw new PublicOriginError('scheme');
  }
  if (
    url.pathname !== '/' ||
    url.username !== '' ||
    url.password !== '' ||
    raw.includes('?') ||
    raw.includes('#')
  ) {
    throw new PublicOriginError('origin');
  }
  return url.origin;
}
