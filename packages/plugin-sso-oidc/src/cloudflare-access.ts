import {
  isReservedProviderId,
  isValidProviderId,
  normalizeEmail,
  type DomainPolicy,
  type IdentityContext,
  type IdentityFailure,
  type IdentityProvider,
  type IdentityResult,
  type VerifiedIdentity,
} from '@package-broker/core/plugin';
import { checkPolicy } from './config.js';
import { createJwksCache } from './jwks.js';
import { JwtError, type JwtFailure, type VerifiedClaims, verifyJwt } from './jwt.js';

export interface CloudflareAccessConfig {
  readonly id: string;
  readonly kind: 'cloudflare-access';
  readonly displayName?: string;
  readonly teamDomain: string;
  readonly audience: string;
  readonly policy: DomainPolicy;
  readonly trustEmailVerification: boolean;
}

const ASSERTION_HEADER = 'Cf-Access-Jwt-Assertion';
const DEFAULT_DISPLAY_NAME = 'Cloudflare Access';
const AUDIENCE_PATTERN = /^[0-9a-f]{64}$/;
const TEAM_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const GROUPS_UNSUPPORTED = 'groups are not supported until spike T172';
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'kind',
  'displayName',
  'teamDomain',
  'audience',
  'policy',
  'trustEmailVerification',
]);

function unknownKeyProblems(candidate: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const keys = new Set<string | symbol>(Reflect.ownKeys(candidate));
  for (const key in candidate) {
    keys.add(key);
  }
  for (const key of keys) {
    const hidden =
      !Object.hasOwn(candidate, key) || !Object.prototype.propertyIsEnumerable.call(candidate, key);
    if (key !== 'groups' && (typeof key !== 'string' || !ALLOWED_KEYS.has(key) || hidden)) {
      problems.push('unknown configuration key');
    }
  }
  return problems;
}

interface Inspection {
  readonly problems: string[];
  readonly policy: unknown;
}

export function cloudflareAccessProblems(config: unknown): string[] {
  return inspect(config).problems;
}

function inspect(config: unknown): Inspection {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { problems: ['configuration must be an object'], policy: undefined };
  }
  const candidate = config as Record<string, unknown>;
  const problems: string[] = [];
  const { id, kind, displayName, teamDomain, audience, trustEmailVerification } = candidate;
  if (typeof id !== 'string' || !isValidProviderId(id) || isReservedProviderId(id)) {
    problems.push('id must be a valid, non-reserved provider id');
  }
  if (kind !== 'cloudflare-access') {
    problems.push("kind must be 'cloudflare-access'");
  }
  if (displayName !== undefined && (typeof displayName !== 'string' || displayName === '')) {
    problems.push('displayName must be a non-empty string when present');
  }
  if (typeof teamDomain !== 'string' || !TEAM_DOMAIN_PATTERN.test(teamDomain)) {
    problems.push(
      'teamDomain must be <team>.cloudflareaccess.com in lowercase, without scheme, port or path',
    );
  }
  if (typeof audience !== 'string' || !AUDIENCE_PATTERN.test(audience)) {
    problems.push('audience must be 64 lowercase hexadecimal characters');
  }
  if (typeof trustEmailVerification !== 'boolean') {
    problems.push('trustEmailVerification must be a boolean');
  }
  const policy = checkPolicy(candidate.policy);
  problems.push(...policy.problems.map((problem) => `policy: ${problem}`));
  if ('groups' in candidate || policy.groups) {
    problems.push(GROUPS_UNSUPPORTED);
  }
  problems.push(...unknownKeyProblems(candidate));
  return { problems, policy: policy.snapshot };
}

function failure(reason: IdentityFailure): IdentityResult {
  return { ok: false, reason };
}

function failureForJwt(reason: JwtFailure): IdentityFailure {
  switch (reason) {
    case 'jwks_unavailable':
      return 'provider_error';
    case 'malformed':
    case 'unsupported_alg':
    case 'unknown_kid':
    case 'bad_signature':
    case 'wrong_issuer':
    case 'wrong_audience':
    case 'expired':
    case 'not_yet_valid':
    case 'issued_in_future':
    case 'bad_claim':
      return 'invalid_token';
  }
}

function isApplicationAssertion(claims: VerifiedClaims, audience: string): boolean {
  const { raw } = claims;
  return (
    claims.aud.length === 1 &&
    claims.aud[0] === audience &&
    raw.common_name === undefined &&
    (raw.type === undefined || raw.type === 'app')
  );
}

export function createCloudflareAccessProvider(
  config: CloudflareAccessConfig,
  ctx: IdentityContext,
): IdentityProvider {
  const inspection = inspect(config);
  if (inspection.problems.length > 0) {
    throw new RangeError(
      `invalid cloudflare-access configuration: ${inspection.problems.join('; ')}`,
    );
  }
  const { id, teamDomain, audience, trustEmailVerification } = config;
  const checked = inspection.policy as DomainPolicy;
  const policy: DomainPolicy = Object.freeze({
    verifiedDomains: Object.freeze([...checked.verifiedDomains]),
    autoJoin: checked.autoJoin,
  });
  const issuer = `https://${teamDomain}`;
  const keys = createJwksCache({ url: `${issuer}/cdn-cgi/access/certs`, ctx });

  async function finish(input: { readonly request: Request }): Promise<IdentityResult> {
    const token = input.request.headers.get(ASSERTION_HEADER);
    if (token === null || token === '') {
      return failure('missing_credentials');
    }
    let claims: VerifiedClaims;
    try {
      claims = await verifyJwt(token, { keys, issuer, audience, clock: ctx.clock });
    } catch (error) {
      return failure(error instanceof JwtError ? failureForJwt(error.failure) : 'provider_error');
    }
    if (!isApplicationAssertion(claims, audience)) {
      return failure('invalid_token');
    }
    const { email: claimed } = claims.raw;
    const email = typeof claimed === 'string' ? normalizeEmail(claimed) : null;
    if (email === null) {
      return failure('email_missing');
    }
    const identity: VerifiedIdentity = {
      provider: id,
      subject: claims.sub,
      email,
      emailVerified: trustEmailVerification,
      displayName: null,
      groups: [],
      issuedAt: new Date(claims.iat * 1000).toISOString(),
      authTime: null,
    };
    return { ok: true, identity };
  }

  return {
    id,
    kind: 'cloudflare-access',
    displayName: config.displayName ?? DEFAULT_DISPLAY_NAME,
    trustAnchor: `access:${teamDomain}/${audience}`,
    policy,
    supportsReauth: false,
    start: (input) =>
      input.purpose === 'reauth'
        ? Promise.reject(new Error('re-authentication is not supported'))
        : Promise.resolve({ kind: 'direct' }),
    finish,
  };
}
