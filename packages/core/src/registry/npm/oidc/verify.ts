import type { PolicyFetch } from '../../../sources/policy-fetch.js';
import { base64url, decodeJson, invalid, OidcError, record } from './input.js';
import { OIDC_ISSUER, oidcKey } from './jwks.js';
export { clearJwksCache } from './jwks.js';
export { OidcError } from './input.js';

export interface VerifiedOidcClaims {
  readonly issuer: string;
  readonly jti: string;
  readonly expiresAt: number;
  readonly repositoryId: string;
  readonly repositoryOwnerId: string;
  readonly repository: string;
  readonly workflow: string;
  readonly environment: string;
  readonly ref: string;
  readonly eventName: string;
  readonly repositoryVisibility: 'public' | 'private' | 'internal';
}
export interface OidcVerifyInput {
  readonly publicUrl: string;
  readonly policyFetch: PolicyFetch;
  readonly now: number;
}

export function isWorkflowFilename(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !/\p{Cs}/u.test(value) &&
    value.length >= 1 &&
    value.length <= 255 &&
    new TextEncoder().encode(value).length <= 255 &&
    /\.ya?ml$/.test(value) &&
    /^[\x20-\x7e\u0080-\u{10ffff}]+$/u.test(value) &&
    !/[/@]/.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}

export function createOidcVerifier(
  input: Omit<OidcVerifyInput, 'now'>,
): (jwt: string, now: number) => Promise<VerifiedOidcClaims> {
  let hostname: string;
  try {
    hostname = new URL(input.publicUrl).hostname;
    if (!hostname) throw new Error();
  } catch {
    throw new OidcError('invalid_oidc_config');
  }
  const audience = `npm:${hostname}`;
  return (jwt, now) => verifyToken(jwt, { policyFetch: input.policyFetch, now }, audience);
}

function claim(value: unknown, max: number, pattern = /^[^\p{Cc}]+$/u): string {
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).length > max ||
    !pattern.test(value)
  )
    invalid();
  return value;
}
function numeric(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 253402297199
  )
    invalid();
  return value;
}

export async function verifyOidcToken(
  jwt: string,
  input: OidcVerifyInput,
): Promise<VerifiedOidcClaims> {
  return createOidcVerifier(input)(jwt, input.now);
}

async function verifyToken(
  jwt: string,
  input: Omit<OidcVerifyInput, 'publicUrl'>,
  audience: string,
): Promise<VerifiedOidcClaims> {
  if (
    typeof jwt !== 'string' ||
    jwt.length > 8192 ||
    !Number.isSafeInteger(input.now) ||
    input.now < 0
  )
    invalid();
  const parts = jwt.split('.');
  if (parts.length !== 3) invalid();
  const header = decodeJson(base64url(parts[0]!, 1024));
  const payload = decodeJson(base64url(parts[1]!, 5632));
  const signature = base64url(parts[2]!, 1024);
  if (
    !record(header) ||
    header.alg !== 'RS256' ||
    header.typ !== 'JWT' ||
    ['jku', 'x5u', 'crit'].some((name) => Object.hasOwn(header, name))
  )
    invalid();
  const kid = claim(header.kid, 256, /^[\x21-\x7e]+$/);
  if (!record(payload) || payload.iss !== OIDC_ISSUER || payload.aud !== audience) invalid();
  const iat = numeric(payload.iat),
    exp = numeric(payload.exp),
    nbf = numeric(payload.nbf);
  const now = input.now / 1000;
  if (iat > now + 60 || nbf > now + 60 || exp < now - 60 || exp <= iat || exp <= nbf) invalid();
  const workflowRef = claim(payload.workflow_ref, 1024, /^[\x20-\x7e\u0080-\u{10ffff}]+$/u);
  const workflow =
    /^([A-Za-z0-9_-]{1,39}\/[A-Za-z0-9_.-]{1,100})\/\.github\/workflows\/([^/@]{1,255})@([^\s\p{Cc}]{1,767})$/u.exec(
      workflowRef,
    );
  if (!workflow || !isWorkflowFilename(workflow[2])) invalid();
  const visibility = payload.repository_visibility;
  if (visibility !== 'public' && visibility !== 'private' && visibility !== 'internal') invalid();
  const verified: VerifiedOidcClaims = {
    issuer: OIDC_ISSUER,
    jti: claim(payload.jti, 256, /^[A-Za-z0-9_-]+$/),
    expiresAt: exp,
    repositoryId: claim(payload.repository_id, 20, /^[1-9][0-9]*$/),
    repositoryOwnerId: claim(payload.repository_owner_id, 20, /^[1-9][0-9]*$/),
    repository: workflow[1]!.toLowerCase(),
    workflow: workflow[2]!,
    environment:
      payload.environment === undefined || payload.environment === ''
        ? ''
        : claim(payload.environment, 255).replace(/[A-Z]/g, (ch) => ch.toLowerCase()),
    ref: claim(payload.ref, 1024, /^[^\s\p{Cc}]+$/u),
    eventName: claim(payload.event_name, 64, /^[a-z][a-z0-9_]*$/),
    repositoryVisibility: visibility,
  };
  const key = await oidcKey(kid, input.policyFetch, input.now);
  if (!key) invalid();
  try {
    if (
      !(await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        signature,
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      ))
    )
      invalid();
  } catch {
    return invalid();
  }
  return verified;
}
