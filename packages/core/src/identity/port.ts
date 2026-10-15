import type { Clock } from '../ids.js';

const PROVIDER_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const RESERVED_IDS: ReadonlySet<string> = new Set(['local']);
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const ACCESS_ANCHOR = new RegExp(`^access:(?=[^/]{1,253}/)${LABEL}(?:\\.${LABEL})+/[0-9a-f]{64}$`);
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const AUTHORITY = /^(?:\[[0-9a-fA-F:.]+\]|[^:[\]@]+)(?::\d{1,5})?$/;
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const UNSAFE_SUBJECT_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const MAX_TRUST_ANCHOR_LENGTH = 512;
const MAX_SUBJECT_LENGTH = 255;

export const RESERVED_PROVIDER_IDS: readonly string[] = Object.freeze([...RESERVED_IDS]);

export function isValidProviderId(id: string): boolean {
  return PROVIDER_ID.test(id);
}

export function isReservedProviderId(id: string): boolean {
  return RESERVED_IDS.has(id);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || LOOPBACK_IPV4.test(hostname);
}

function isValidOidcIssuer(issuer: string): boolean {
  const scheme = issuer.startsWith('https://')
    ? 'https:'
    : issuer.startsWith('http://')
      ? 'http:'
      : null;
  if (scheme === null || /[?#\\]/.test(issuer)) {
    return false;
  }
  const rest = issuer.slice(scheme.length + 2);
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash);
  if (!AUTHORITY.test(authority)) {
    return false;
  }
  const dotSegment = path
    .split('/')
    .some((segment) => ['.', '..'].includes(segment.toLowerCase().replaceAll('%2e', '.')));
  if (dotSegment) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return false;
  }
  if (url.protocol !== scheme || url.username !== '' || url.password !== '') {
    return false;
  }
  return scheme === 'https:' || isLoopbackHost(url.hostname);
}

export function isValidTrustAnchor(anchor: string): boolean {
  if (anchor.length > MAX_TRUST_ANCHOR_LENGTH || !PRINTABLE_ASCII.test(anchor)) {
    return false;
  }
  if (anchor.startsWith('oidc:')) {
    return isValidOidcIssuer(anchor.slice('oidc:'.length));
  }
  return ACCESS_ANCHOR.test(anchor);
}

export function isValidSubject(subject: unknown): subject is string {
  return (
    typeof subject === 'string' &&
    subject.length >= 1 &&
    subject.length <= MAX_SUBJECT_LENGTH &&
    !UNSAFE_SUBJECT_CHARACTER.test(subject)
  );
}

export interface VerifiedIdentity {
  readonly provider: string;
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
  readonly groups: readonly string[];
  readonly issuedAt: string;
  readonly authTime: string | null;
}

export interface DomainPolicy {
  readonly verifiedDomains: readonly string[];
  readonly autoJoin: boolean;
}

export type LoginStateData = Readonly<Record<string, string>>;

export type StartResult =
  | { readonly kind: 'redirect'; readonly location: string; readonly state: LoginStateData }
  | { readonly kind: 'direct' };

export type IdentityFailure =
  'missing_credentials' | 'invalid_token' | 'state_mismatch' | 'provider_error' | 'email_missing';

export type IdentityResult =
  | { readonly ok: true; readonly identity: VerifiedIdentity }
  | { readonly ok: false; readonly reason: IdentityFailure };

export interface IdentityProvider {
  readonly id: string;
  readonly kind: 'cloudflare-access' | 'oidc';
  readonly displayName: string;
  readonly trustAnchor: string;
  readonly policy: DomainPolicy;
  readonly supportsReauth: boolean;
  start(input: {
    readonly request: Request;
    readonly purpose: 'login' | 'reauth';
    readonly callbackUrl: string;
  }): Promise<StartResult>;
  finish(input: {
    readonly request: Request;
    readonly state: LoginStateData | null;
    readonly callbackUrl: string;
  }): Promise<IdentityResult>;
}

export interface IdentityContext {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly clock: Clock;
  readonly env: (name: string) => string | undefined;
}

export type IdentityProviderFactory = (ctx: IdentityContext) => readonly IdentityProvider[];
