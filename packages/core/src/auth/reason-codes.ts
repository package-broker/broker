import type { LoginRefusal } from './identity-login.js';
import type { ReauthRefusal } from './identity-reauth.js';
import type { IdentityFailure, IdentityFailureDetail } from '../identity/port.js';

function reasonSet<const T extends string>(reasons: Record<T, true>): ReadonlySet<T> {
  return new Set(Object.keys(reasons) as T[]);
}

export const START_FAILURE_DETAILS = reasonSet({
  secret_missing: true,
  callback_invalid: true,
  purpose_invalid: true,
  discovery_invalid: true,
  discovery_failed: true,
  discovery_redirect: true,
  discovery_status: true,
  discovery_content_type: true,
  discovery_too_large: true,
  discovery_timeout: true,
  discovery_network: true,
  discovery_bad_json: true,
});

export const FINISH_FAILURE_DETAILS = reasonSet({
  invalid_grant: true,
  invalid_client: true,
  invalid_request: true,
  unauthorized_client: true,
  unsupported_grant_type: true,
  invalid_scope: true,
  token_endpoint_error: true,
} satisfies Record<IdentityFailureDetail, true>);

export const IDENTITY_FAILURES = reasonSet({
  missing_credentials: true,
  invalid_token: true,
  state_mismatch: true,
  provider_error: true,
  email_missing: true,
} satisfies Record<IdentityFailure, true>);

export const LOGIN_REFUSALS = reasonSet({
  email_missing: true,
  email_unverified: true,
  domain_not_verified: true,
  not_invited: true,
  user_suspended: true,
  hook_denied: true,
  too_many_groups: true,
  already_linked: true,
  link_requires_admin: true,
  invalid_identity: true,
  provider_rebound: true,
  email_changed: true,
  conflict: true,
} satisfies Record<LoginRefusal, true>);

export const REAUTH_REFUSALS = reasonSet({
  session_inactive: true,
  not_sso_session: true,
  not_supported: true,
  state_mismatch: true,
  identity_mismatch: true,
  anchor_mismatch: true,
  no_auth_time: true,
  stale_auth_time: true,
  policy: true,
  hook_denied: true,
  not_updated: true,
} satisfies Record<ReauthRefusal, true>);

export const AUTH_REASON_CODES = readonlySet([
  ...START_FAILURE_DETAILS,
  ...FINISH_FAILURE_DETAILS,
  ...IDENTITY_FAILURES,
  ...LOGIN_REFUSALS,
  ...REAUTH_REFUSALS,
  'login_refused',
  'reauth_refused',
  'no_session',
  'direct_reauth',
  'state_invalid',
  'cross_site',
  'origin_mismatch',
  'origin_missing',
  'token_missing',
  'token_mismatch',
  'attempts',
]);

function readonlySet<const T extends string>(values: readonly T[]): ReadonlySet<T> {
  return new Set(values);
}

export type AuthReasonCode = typeof AUTH_REASON_CODES extends ReadonlySet<infer T> ? T : never;

export function isAuthReasonCode(value: unknown): value is AuthReasonCode {
  return typeof value === 'string' && (AUTH_REASON_CODES as ReadonlySet<string>).has(value);
}
