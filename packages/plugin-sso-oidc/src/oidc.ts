import {
  base64urlEncode,
  constantTimeEqual,
  isReservedProviderId,
  isValidProviderId,
  isValidTrustAnchor,
  providerSecretName,
  randomToken,
  sha256Hex,
  type DomainPolicy,
  type IdentityContext,
  type IdentityFailure,
  type IdentityProvider,
  type IdentityResult,
  type LoginStateData,
  type StartResult,
} from '@package-broker/core/plugin';
import {
  checkPolicy,
  copyList,
  copyOwn,
  hasHiddenKeys,
  HIDDEN_KEYS_PROBLEM,
  isPlainContainer,
  MAX_LIST_LENGTH,
} from './config.js';
import {
  BoundedFetchError,
  fetchBounded,
  tokenEndpointError,
  type BoundedFetchFailure,
  type TokenEndpointError,
} from './http.js';
import { createJwksCache } from './jwks.js';
import { JwtError, verifyJwt, type KeySource, type VerifiedClaims } from './jwt.js';

export interface OidcConfig {
  readonly id: string;
  readonly kind: 'oidc';
  readonly displayName?: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly policy: DomainPolicy;
  readonly scopes?: readonly string[];
  readonly trustedAudiences?: readonly string[];
  readonly trustedEndpointOrigins?: readonly string[];
}

export { tokenEndpointError, type TokenEndpointError } from './http.js';

export type OidcFailureDetail =
  | TokenEndpointError
  | 'secret_missing'
  | 'callback_invalid'
  | 'purpose_invalid'
  | 'discovery_invalid'
  | 'discovery_failed'
  | 'token_response_invalid'
  | `discovery_${BoundedFetchFailure}`;

export class OidcProviderError extends Error {
  readonly reason = 'provider_error' as const;
  readonly detail: OidcFailureDetail;

  constructor(detail: OidcFailureDetail) {
    super(`oidc provider error: ${detail}`);
    this.name = 'OidcProviderError';
    this.detail = detail;
  }
}

const DISCOVERY_MAX_BYTES = 64 * 1024;
const DISCOVERY_TIMEOUT_MS = 5000;
const TOKEN_MAX_BYTES = 64 * 1024;
const TOKEN_TIMEOUT_MS = 5000;
const DEFAULT_SCOPES: readonly string[] = ['openid', 'email', 'profile', 'groups'];
const OWNED_AUTHORIZATION_PARAMETERS: readonly string[] = [
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'nonce',
  'code_challenge',
  'code_challenge_method',
  'prompt',
  'max_age',
  'response_mode',
  'request',
  'request_uri',
  'id_token_hint',
  'login_hint',
  'acr_values',
  'display',
  'ui_locales',
  'claims',
  'claims_locales',
  'registration',
  'client_secret',
  'code',
  'code_verifier',
];
const DISCOVERY_FAILURE_TTL_MS = 30_000;
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'id',
  'kind',
  'displayName',
  'issuer',
  'clientId',
  'policy',
  'scopes',
  'trustedAudiences',
  'trustedEndpointOrigins',
]);
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_CLIENT_ID_LENGTH = 255;
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_LIST_ENTRY_LENGTH = 255;
const UNRESERVED_CHARACTER = /^[A-Za-z0-9\-._~]$/;
const DEFAULT_PORT = /^https?:\/\/[^/]*:(?:443|80)(?:\/|$)/;
const UNSAFE_DISPLAY_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const CLIENT_ID = /^[\x21-\x7e]+$/;
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const FETCH_FAILURE: Readonly<Record<BoundedFetchFailure, OidcFailureDetail>> = {
  redirect: 'discovery_redirect',
  status: 'discovery_status',
  content_type: 'discovery_content_type',
  too_large: 'discovery_too_large',
  timeout: 'discovery_timeout',
  network: 'discovery_network',
  bad_json: 'discovery_bad_json',
};

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || LOOPBACK_IPV4.test(hostname);
}

function isSecureOrLoopback(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
}

interface Snapshot {
  readonly config: Record<string, unknown>;
  readonly problems: readonly string[];
}

function snapshot(raw: unknown): Snapshot {
  if (!isPlainContainer(raw)) {
    throw new TypeError('config must be an object');
  }
  const problems: string[] = [];
  if (hasHiddenKeys(raw)) {
    problems.push(`configuration ${HIDDEN_KEYS_PROBLEM}`);
  }
  const copy = copyOwn(raw);
  for (const key of ['scopes', 'trustedAudiences', 'trustedEndpointOrigins']) {
    if (Object.hasOwn(copy, key)) {
      copy[key] = copyList(copy[key]);
    }
  }
  const policy = checkPolicy(copy['policy']);
  copy['policy'] = policy.snapshot;
  problems.push(...policy.problems.map((problem) => `policy: ${problem}`));
  if (policy.groups) {
    problems.push('policy: unsupported key "groups"');
  }
  return { config: copy, problems };
}

function isTrustedOrigin(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > MAX_ENDPOINT_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.origin === value && isSecureOrLoopback(url);
  } catch {
    return false;
  }
}

function stringListProblems(
  value: unknown,
  name: string,
  valid: (entry: unknown) => boolean,
  rule: string,
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LIST_LENGTH) {
    return [`${name} must be an array of 1 to ${MAX_LIST_LENGTH} entries`];
  }
  const problems: string[] = [];
  (value as unknown[]).forEach((entry, index) => {
    if (!valid(entry)) {
      problems.push(`${name}[${index}] ${rule}`);
    }
  });
  return problems;
}

function isListEntry(entry: unknown): entry is string {
  return typeof entry === 'string' && entry.length >= 1 && entry.length <= MAX_LIST_ENTRY_LENGTH;
}

function hasNonCanonicalEscape(path: string): boolean {
  for (const [, hex] of path.matchAll(/%([0-9a-fA-F]{2})/g)) {
    const escape = hex as string;
    if (escape !== escape.toUpperCase()) {
      return true;
    }
    if (UNRESERVED_CHARACTER.test(String.fromCharCode(Number.parseInt(escape, 16)))) {
      return true;
    }
  }
  return false;
}

function issuerFormProblems(issuer: string): string[] {
  const url = new URL(issuer);
  const authority = issuer.slice(url.protocol.length + 2).split('/', 1)[0] as string;
  const path = issuer.slice(url.protocol.length + 2 + authority.length);
  if (authority !== authority.toLowerCase()) {
    return [
      `issuer host must be lowercase: ${issuer.slice(0, url.protocol.length + 2)}${authority.toLowerCase()}${path}`,
    ];
  }
  if (DEFAULT_PORT.test(issuer) && url.port === '') {
    return ['issuer must not name the default port'];
  }
  const serialised =
    url.href.endsWith('/') && url.pathname === '/' ? url.href.slice(0, -1) : url.href;
  const canonical =
    serialised === `${url.protocol}//${authority.toLowerCase()}${path}` &&
    !url.hostname.endsWith('.') &&
    !path.includes('//') &&
    !hasNonCanonicalEscape(path);
  return canonical ? [] : ['issuer must be in canonical URL form'];
}

function snapshotProblems(config: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      problems.push(`unsupported key ${JSON.stringify(key.slice(0, 40))}`);
    }
  }
  const { id, kind, displayName, issuer, clientId, scopes } = config;
  if (typeof id !== 'string' || !isValidProviderId(id)) {
    problems.push('id must be a valid provider id');
  } else if (isReservedProviderId(id)) {
    problems.push('id is reserved');
  }
  if (kind !== 'oidc') {
    problems.push('kind must be "oidc"');
  }
  if (
    displayName !== undefined &&
    (typeof displayName !== 'string' ||
      displayName.length < 1 ||
      displayName.length > MAX_DISPLAY_NAME_LENGTH ||
      UNSAFE_DISPLAY_CHARACTER.test(displayName))
  ) {
    problems.push(
      `displayName must be 1 to ${MAX_DISPLAY_NAME_LENGTH} characters without control or format characters`,
    );
  }
  if (typeof issuer !== 'string' || !isValidTrustAnchor(`oidc:${issuer}`) || issuer.endsWith('/')) {
    problems.push(
      'issuer must be an https URL (or http on a loopback host) without query, fragment, credentials or trailing slash',
    );
  } else {
    problems.push(...issuerFormProblems(issuer));
  }
  if (
    typeof clientId !== 'string' ||
    clientId.length < 1 ||
    clientId.length > MAX_CLIENT_ID_LENGTH ||
    !CLIENT_ID.test(clientId)
  ) {
    problems.push(`clientId must be 1 to ${MAX_CLIENT_ID_LENGTH} printable ASCII characters`);
  }
  problems.push(
    ...stringListProblems(
      scopes,
      'scopes',
      (entry) => isListEntry(entry) && SCOPE_TOKEN.test(entry) && entry !== 'offline_access',
      `must be a scope token of at most ${MAX_LIST_ENTRY_LENGTH} characters and must not be offline_access`,
    ),
    ...stringListProblems(
      config['trustedAudiences'],
      'trustedAudiences',
      (entry) => isListEntry(entry) && CLIENT_ID.test(entry),
      `must be 1 to ${MAX_LIST_ENTRY_LENGTH} printable ASCII characters`,
    ),
    ...stringListProblems(
      config['trustedEndpointOrigins'],
      'trustedEndpointOrigins',
      isTrustedOrigin,
      'must be an origin (https, or http on a loopback host) without path',
    ),
  );
  return problems;
}

export function oidcProblems(config: unknown): string[] {
  try {
    const { config: copy, problems } = snapshot(config);
    return [...problems, ...snapshotProblems(copy)];
  } catch {
    return ['config must be a readable object'];
  }
}

interface Endpoints {
  readonly authorization: string;
  readonly token: string;
  readonly jwks: string;
}

function endpointOf(
  value: unknown,
  issuer: URL,
  trusted: ReadonlySet<string>,
  allowQuery: boolean,
): URL | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ENDPOINT_LENGTH) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '' || value.includes('#')) {
    return null;
  }
  if (!allowQuery && value.includes('?')) {
    return null;
  }
  const schemeAllowed =
    url.protocol === 'https:' ||
    (issuer.protocol === 'http:' && url.protocol === 'http:' && isLoopbackHost(url.hostname));
  if (!schemeAllowed) {
    return null;
  }
  return url.origin === issuer.origin || trusted.has(url.origin) ? url : null;
}

function parseDiscovery(
  json: unknown,
  issuer: string,
  issuerUrl: URL,
  trusted: ReadonlySet<string>,
): Endpoints {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new OidcProviderError('discovery_invalid');
  }
  const document = json as Record<string, unknown>;
  if (document['issuer'] !== issuer) {
    throw new OidcProviderError('discovery_invalid');
  }
  const authorization = endpointOf(document['authorization_endpoint'], issuerUrl, trusted, true);
  const token = endpointOf(document['token_endpoint'], issuerUrl, trusted, false);
  const jwks = endpointOf(document['jwks_uri'], issuerUrl, trusted, false);
  if (authorization === null || token === null || jwks === null) {
    throw new OidcProviderError('discovery_invalid');
  }
  const methods = document['code_challenge_methods_supported'];
  if (methods !== undefined && !(Array.isArray(methods) && methods.includes('S256'))) {
    throw new OidcProviderError('discovery_invalid');
  }
  return { authorization: authorization.href, token: token.href, jwks: jwks.href };
}

function effectiveScopes(configured: readonly string[] | undefined): string {
  const unique = [...new Set(configured ?? DEFAULT_SCOPES)];
  return (unique.includes('openid') ? unique : ['openid', ...unique]).join(' ');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function codeChallenge(verifier: string): Promise<string> {
  return base64urlEncode(hexToBytes(await sha256Hex(verifier)));
}

function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

function basicAuthorization(clientId: string, secret: string): string {
  return `Basic ${btoa(`${formEncode(clientId)}:${formEncode(secret)}`)}`;
}

interface StoredLogin {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
}

function readLoginState(data: LoginStateData | null): StoredLogin | null {
  if (data === null) {
    return null;
  }
  const { state, nonce, verifier } = data;
  if (
    typeof state !== 'string' ||
    typeof nonce !== 'string' ||
    typeof verifier !== 'string' ||
    state === '' ||
    nonce === '' ||
    verifier === ''
  ) {
    return null;
  }
  return { state, nonce, verifier };
}

function refuse(reason: IdentityFailure): IdentityResult {
  return { ok: false, reason };
}

function groupsOf(value: unknown): readonly string[] | null {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === 'string')
  ) {
    return null;
  }
  return Object.freeze([...value]);
}

function checkCallbackUrl(callbackUrl: string): void {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new OidcProviderError('callback_invalid');
  }
  if (
    !isSecureOrLoopback(url) ||
    callbackUrl.includes('#') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new OidcProviderError('callback_invalid');
  }
}

export function createOidcProvider(config: OidcConfig, ctx: IdentityContext): IdentityProvider {
  let source: Record<string, unknown>;
  let problems: string[];
  try {
    const taken = snapshot(config);
    source = taken.config;
    problems = [...taken.problems, ...snapshotProblems(source)];
  } catch {
    throw new RangeError('invalid oidc config: config must be a readable object');
  }
  if (problems.length > 0) {
    throw new RangeError(`invalid oidc config: ${problems.join('; ')}`);
  }

  const id = source['id'] as string;
  const issuer = source['issuer'] as string;
  const clientId = source['clientId'] as string;
  const issuerUrl = new URL(issuer);
  const policy = source['policy'] as DomainPolicy;
  const scope = effectiveScopes(source['scopes'] as readonly string[] | undefined);
  const trusted: ReadonlySet<string> = new Set(
    (source['trustedEndpointOrigins'] as readonly string[] | undefined) ?? [],
  );
  const trustedAudiences: ReadonlySet<string> = new Set(
    (source['trustedAudiences'] as readonly string[] | undefined) ?? [],
  );
  const secretName = providerSecretName(id, 'CLIENT_SECRET');
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;

  let discovery: Promise<Endpoints> | null = null;
  let failure: { readonly at: number; readonly detail: OidcFailureDetail } | null = null;

  async function loadDiscovery(): Promise<Endpoints> {
    let json: unknown;
    try {
      ({ json } = await fetchBounded(
        ctx,
        new Request(discoveryUrl, { method: 'GET', headers: { accept: 'application/json' } }),
        { maxBytes: DISCOVERY_MAX_BYTES, timeoutMs: DISCOVERY_TIMEOUT_MS },
      ));
    } catch (error) {
      throw new OidcProviderError(
        error instanceof BoundedFetchError ? FETCH_FAILURE[error.reason] : 'discovery_failed',
      );
    }
    return parseDiscovery(json, issuer, issuerUrl, trusted);
  }

  function discover(): Promise<Endpoints> {
    if (discovery === null) {
      if (failure !== null && ctx.clock.now().getTime() - failure.at < DISCOVERY_FAILURE_TTL_MS) {
        return Promise.reject(new OidcProviderError(failure.detail));
      }
      const attempt: Promise<Endpoints> = loadDiscovery().then(
        (endpoints) => {
          failure = null;
          return endpoints;
        },
        (error: unknown) => {
          if (discovery === attempt) {
            discovery = null;
            failure = {
              at: ctx.clock.now().getTime(),
              detail: error instanceof OidcProviderError ? error.detail : 'discovery_failed',
            };
          }
          throw error;
        },
      );
      discovery = attempt;
    }
    return discovery;
  }

  function readSecret(): string {
    let value: unknown;
    try {
      value = ctx.env(secretName);
    } catch {
      value = undefined;
    }
    if (typeof value !== 'string' || value === '') {
      throw new OidcProviderError('secret_missing');
    }
    return value;
  }

  let keys: KeySource | null = null;

  async function exchangeCode(
    code: string,
    login: StoredLogin,
    callbackUrl: string,
  ): Promise<
    | { readonly ok: true; readonly idToken: string; readonly keys: KeySource }
    | { readonly ok: false; readonly detail: TokenEndpointError }
  > {
    checkCallbackUrl(callbackUrl);
    const secret = readSecret();
    const endpoints = await discover();
    if (new URL(endpoints.token).origin !== issuerUrl.origin) {
      throw new OidcProviderError('discovery_invalid');
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl,
      code_verifier: login.verifier,
    });
    const { status, json } = await fetchBounded(
      ctx,
      new Request(endpoints.token, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          authorization: basicAuthorization(clientId, secret),
        },
        body: body.toString(),
      }),
      { maxBytes: TOKEN_MAX_BYTES, timeoutMs: TOKEN_TIMEOUT_MS, readErrorBody: true },
    );
    if (status < 200 || status >= 300) {
      const refusal = tokenEndpointError(json);
      if (refusal === 'status') throw new BoundedFetchError('status');
      return { ok: false, detail: refusal };
    }
    const idToken = isPlainContainer(json) ? (json as Record<string, unknown>)['id_token'] : null;
    if (typeof idToken !== 'string' || idToken === '') {
      throw new OidcProviderError('token_response_invalid');
    }
    keys ??= createJwksCache({ url: endpoints.jwks, ctx });
    return { ok: true, idToken, keys };
  }

  function audienceAccepted(claims: VerifiedClaims): boolean {
    const azp = claims.raw['azp'];
    if (azp !== undefined ? azp !== clientId : claims.aud.length > 1) {
      return false;
    }
    return claims.aud.every((entry) => entry === clientId || trustedAudiences.has(entry));
  }

  function identityOf(claims: VerifiedClaims, login: StoredLogin): IdentityResult {
    if (!audienceAccepted(claims)) {
      return refuse('invalid_token');
    }
    if (claims.nonce === undefined || !constantTimeEqual(claims.nonce, login.nonce)) {
      return refuse('invalid_token');
    }
    const { email, email_verified: emailVerified, name } = claims.raw;
    if (typeof email !== 'string' || email === '') {
      return refuse('email_missing');
    }
    if (emailVerified !== undefined && typeof emailVerified !== 'boolean') {
      return refuse('invalid_token');
    }
    const groups = groupsOf(claims.raw['groups']);
    if (groups === null) {
      return refuse('invalid_token');
    }
    return {
      ok: true,
      identity: {
        provider: id,
        subject: claims.sub,
        email,
        emailVerified: emailVerified === true,
        displayName: typeof name === 'string' && name !== '' ? name : null,
        groups,
        issuedAt: new Date(claims.iat * 1000).toISOString(),
        authTime: claims.authTime === null ? null : new Date(claims.authTime * 1000).toISOString(),
      },
    };
  }

  return Object.freeze({
    id,
    kind: 'oidc' as const,
    displayName: (source['displayName'] as string | undefined) ?? id,
    trustAnchor: `oidc:${issuer}`,
    policy: Object.freeze({
      verifiedDomains: Object.freeze(policy.verifiedDomains.slice()),
      autoJoin: policy.autoJoin,
    }),
    supportsReauth: true,

    async start(input: {
      readonly purpose: 'login' | 'reauth';
      readonly callbackUrl: string;
    }): Promise<StartResult> {
      if (input.purpose !== 'login' && input.purpose !== 'reauth') {
        throw new OidcProviderError('purpose_invalid');
      }
      readSecret();
      checkCallbackUrl(input.callbackUrl);
      const endpoints = await discover();
      const state = randomToken();
      const nonce = randomToken();
      const verifier = randomToken();
      const url = new URL(endpoints.authorization);
      const params = url.searchParams;
      for (const name of OWNED_AUTHORIZATION_PARAMETERS) {
        params.delete(name);
      }
      params.set('response_type', 'code');
      params.set('client_id', clientId);
      params.set('redirect_uri', input.callbackUrl);
      params.set('scope', scope);
      params.set('state', state);
      params.set('nonce', nonce);
      params.set('code_challenge', await codeChallenge(verifier));
      params.set('code_challenge_method', 'S256');
      if (input.purpose === 'reauth') {
        params.set('prompt', 'login');
        params.set('max_age', '0');
      }
      const loginState: LoginStateData = { state, nonce, verifier };
      return { kind: 'redirect', location: url.toString(), state: loginState };
    },

    async finish(input: {
      readonly request: Request;
      readonly state: LoginStateData | null;
      readonly callbackUrl: string;
    }): Promise<IdentityResult> {
      const login = readLoginState(input.state);
      if (login === null) {
        return refuse('state_mismatch');
      }
      const params = new URL(input.request.url).searchParams;
      const returned = params.getAll('state');
      if (returned.length !== 1 || !constantTimeEqual(returned[0] as string, login.state)) {
        return refuse('state_mismatch');
      }
      if (params.has('error')) {
        return refuse('provider_error');
      }
      const codes = params.getAll('code');
      if (codes.length !== 1 || codes[0] === '') {
        return refuse('missing_credentials');
      }
      let exchanged: { readonly idToken: string; readonly keys: KeySource };
      try {
        const result = await exchangeCode(codes[0] as string, login, input.callbackUrl);
        if (!result.ok) {
          return { ok: false, reason: 'provider_error', detail: result.detail };
        }
        exchanged = result;
      } catch {
        return refuse('provider_error');
      }
      let claims: VerifiedClaims;
      try {
        claims = await verifyJwt(exchanged.idToken, {
          keys: exchanged.keys,
          issuer,
          audience: clientId,
          clock: ctx.clock,
        });
      } catch (error) {
        const tokenFault = error instanceof JwtError && error.failure !== 'jwks_unavailable';
        return refuse(tokenFault ? 'invalid_token' : 'provider_error');
      }
      return identityOf(claims, login);
    },
  });
}
