import type { SourceError } from '../sources/source-service.js';
import type { VisibilityResult } from '../catalogue/visibility-service.js';
import type { AdminError } from '../authz/administration.js';
import type { ProjectError } from '../authz/project-service.js';
import type { PersonalTokenError } from '../authz/pat-service.js';
import type { ServiceTokenError } from '../authz/service-token-service.js';
import type { ServicePrincipalError } from '../authz/service-principal-service.js';
import type { TokenRevokeError } from '../authz/token-revoke.js';
import type { ProjectListError } from '../authz/project-list.js';
import { errorEnvelope } from '../envelope.js';
import type { ValidationDetail } from './validate.js';

export const API_ERROR_CODES = {
  unsupported_package: { status: 400, message: 'Unsupported package' },
  unsupported_source_kind: { status: 400, message: 'Unsupported source kind' },
  package_not_found: { status: 404, message: 'Package not found' },
  invalid_request: { status: 400, message: 'Invalid request' },
  unauthorized: { status: 401, message: 'Authentication required' },
  forbidden: { status: 403, message: 'Access denied' },
  local_auth_disabled: { status: 403, message: 'Local sign-in is disabled' },
  reauth_required: { status: 403, message: 'Reauthentication required' },
  not_found: { status: 404, message: 'Not found' },
  conflict: { status: 409, message: 'Conflict' },
  source_paused: { status: 409, message: 'Source is paused' },
  duplicate: { status: 409, message: 'Already exists' },
  last_holder: { status: 409, message: 'Last holder cannot be removed' },
  idempotency_mismatch: { status: 409, message: 'Idempotency key does not match' },
  already_issued: { status: 409, message: 'Already issued' },
  not_approved: { status: 409, message: 'Approval required' },
  precondition_failed: { status: 412, message: 'Precondition failed' },
  precondition_required: { status: 428, message: 'Precondition required' },
  payload_too_large: { status: 413, message: 'Payload too large' },
  unsupported_media_type: { status: 415, message: 'Unsupported media type' },
  not_acceptable: { status: 406, message: 'Not acceptable' },
  upstream_refused: { status: 502, message: 'Upstream request refused' },
  bad_gateway: { status: 502, message: 'Bad gateway' },
  gone: { status: 410, message: 'Archive is no longer available' },
  unavailable: { status: 503, message: 'Service unavailable' },
  invalid_version: { status: 400, message: 'The package version is invalid' },
  invalid_attachments: { status: 400, message: 'The package attachments are invalid' },
  invalid_attachment: { status: 400, message: 'The package attachment is invalid' },
  provenance_unsupported: { status: 400, message: 'Package provenance is not supported' },
  integrity_mismatch: { status: 400, message: 'The package integrity does not match the tarball' },
  invalid_tarball: { status: 400, message: 'The package tarball is invalid' },
  manifest_mismatch: { status: 400, message: 'The package manifest does not match the tarball' },
  license_missing: { status: 400, message: 'A license is required to publish' },
  too_many_tags: { status: 400, message: 'The package has too many tags' },
  token_required: { status: 401, message: 'A token is required to publish' },
  scope: { status: 403, message: 'The token scope does not permit this operation' },
  not_admitted: { status: 403, message: 'The package is not admitted to this project' },
  self_approval: { status: 403, message: 'You cannot approve your own publish' },
  package_binding: { status: 403, message: 'The token is bound to a different package' },
  no_trusted_publisher: { status: 403, message: 'No trusted publisher matches this workload' },
  claim_in_use: { status: 409, message: 'This claim still covers hosted packages' },
  claim_overlap: { status: 409, message: 'This package name is already published or proxied' },
  name_public: { status: 409, message: 'This package name is already published publicly' },
  name_public_unverified: { status: 409, message: 'The public package name could not be verified' },
  name_not_claimed: { status: 409, message: 'This package name has not been claimed' },
  version_exists: { status: 409, message: 'This package version already exists' },
  publish_gate: {
    status: 409,
    message: 'Approval is required before this version can be released',
  },
  too_many_sessions: { status: 409, message: 'There are too many pending login sessions' },
  ambiguous_trusted_publisher: {
    status: 409,
    message: 'More than one trusted publisher matches this workload',
  },
  manifest_too_large: { status: 413, message: 'The package manifest is too large' },
  tarball_too_large: { status: 413, message: 'The package tarball is too large' },
  write_unsupported: { status: 405, message: 'This write operation is not supported' },
  busy: { status: 503, message: 'Publishing is busy, try again later' },
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_CODES;

type ServiceErrorMapping = {
  [Code in ApiErrorCode]: {
    readonly status: (typeof API_ERROR_CODES)[Code]['status'];
    readonly code: Code;
  };
}[ApiErrorCode];

export const SERVICE_ERROR_TABLE = {
  SourceError: {
    source_paused: { status: 409, code: 'source_paused' },
    forbidden: { status: 403, code: 'forbidden' },
    not_found: { status: 404, code: 'not_found' },
    invalid_config: { status: 400, code: 'invalid_request' },
    credential_scope_mismatch: { status: 404, code: 'not_found' },
    duplicate: { status: 409, code: 'duplicate' },
    conflict: { status: 409, code: 'conflict' },
    indeterminate: { status: 503, code: 'unavailable' },
    activation_requires_registered_names: { status: 409, code: 'conflict' },
    has_packages: { status: 409, code: 'conflict' },
    has_history: { status: 409, code: 'conflict' },
    invalid_pattern: { status: 400, code: 'invalid_request' },
    proxy_source: { status: 400, code: 'invalid_request' },
    pattern_taken: { status: 409, code: 'conflict' },
    claim_in_use: { status: 409, code: 'claim_in_use' },
    claim_overlap: { status: 409, code: 'claim_overlap' },
    name_public: { status: 409, code: 'name_public' },
    name_public_unverified: { status: 409, code: 'name_public_unverified' },
    invalid_name: { status: 400, code: 'invalid_request' },
  } satisfies Record<SourceError, ServiceErrorMapping>,
  VisibilityError: {
    forbidden: { status: 403, code: 'forbidden' },
    collision: { status: 409, code: 'conflict' },
    conflict: { status: 409, code: 'conflict' },
    not_found: { status: 404, code: 'not_found' },
    not_attached: { status: 404, code: 'not_found' },
    unclassified: { status: 503, code: 'unavailable' },
    invalid_pattern: { status: 400, code: 'invalid_request' },
    too_many_patterns: { status: 400, code: 'invalid_request' },
    not_eligible: { status: 409, code: 'conflict' },
  } satisfies Record<Extract<VisibilityResult, { ok: false }>['error'], ServiceErrorMapping>,
  AdminError: {
    invalid_permission: { status: 400, code: 'invalid_request' },
    invalid_key: { status: 400, code: 'invalid_request' },
    invalid_name: { status: 400, code: 'invalid_request' },
    invalid_subject: { status: 400, code: 'invalid_request' },
    unknown_provider: { status: 400, code: 'invalid_request' },
    locked: { status: 409, code: 'conflict' },
    system_role: { status: 409, code: 'conflict' },
    in_use: { status: 409, code: 'conflict' },
    duplicate: { status: 409, code: 'duplicate' },
    role_scope_mismatch: { status: 400, code: 'invalid_request' },
    last_holder: { status: 409, code: 'last_holder' },
    not_found: { status: 404, code: 'not_found' },
    conflict: { status: 409, code: 'conflict' },
    invalid_revision: { status: 400, code: 'invalid_request' },
    indeterminate: { status: 503, code: 'unavailable' },
    forbidden: { status: 403, code: 'forbidden' },
  } satisfies Record<AdminError, ServiceErrorMapping>,
  ProjectError: {
    forbidden: { status: 403, code: 'forbidden' },
    reauth_required: { status: 403, code: 'reauth_required' },
    invalid_name: { status: 400, code: 'invalid_request' },
    invalid_scope: { status: 400, code: 'invalid_request' },
    invalid_policy: { status: 400, code: 'invalid_request' },
    invalid_revision: { status: 400, code: 'invalid_request' },
    invalid_slug: { status: 400, code: 'invalid_request' },
    reserved_slug: { status: 400, code: 'invalid_request' },
    initial_role_not_allowed: { status: 400, code: 'invalid_request' },
    duplicate: { status: 409, code: 'duplicate' },
    no_changes: { status: 400, code: 'invalid_request' },
    archived: { status: 409, code: 'conflict' },
    wrong_state: { status: 409, code: 'conflict' },
    not_found: { status: 404, code: 'not_found' },
    conflict: { status: 409, code: 'conflict' },
    indeterminate: { status: 503, code: 'unavailable' },
  } satisfies Record<ProjectError, ServiceErrorMapping>,
  PersonalTokenError: {
    reauth_required: { status: 403, code: 'reauth_required' },
    invalid_name: { status: 400, code: 'invalid_request' },
    invalid_scope: { status: 400, code: 'invalid_request' },
    scope_conflict: { status: 400, code: 'invalid_request' },
    invalid_expiry: { status: 400, code: 'invalid_request' },
    invalid_projects: { status: 400, code: 'invalid_request' },
    forbidden: { status: 403, code: 'forbidden' },
    conflict: { status: 409, code: 'conflict' },
    indeterminate: { status: 503, code: 'unavailable' },
  } satisfies Record<PersonalTokenError, ServiceErrorMapping>,
  ServiceTokenError: {
    reauth_required: { status: 403, code: 'reauth_required' },
    invalid_name: { status: 400, code: 'invalid_request' },
    invalid_scope: { status: 400, code: 'invalid_request' },
    scope_conflict: { status: 400, code: 'invalid_request' },
    invalid_expiry: { status: 400, code: 'invalid_request' },
    forbidden: { status: 403, code: 'forbidden' },
    not_found: { status: 404, code: 'not_found' },
    conflict: { status: 409, code: 'conflict' },
    indeterminate: { status: 503, code: 'unavailable' },
  } satisfies Record<ServiceTokenError, ServiceErrorMapping>,
  ServicePrincipalError: {
    reauth_required: { status: 403, code: 'reauth_required' },
    forbidden: { status: 403, code: 'forbidden' },
    invalid_name: { status: 400, code: 'invalid_request' },
    invalid_permission: { status: 400, code: 'invalid_request' },
    invalid_revision: { status: 400, code: 'invalid_request' },
    project_mismatch: { status: 400, code: 'invalid_request' },
    duplicate: { status: 409, code: 'duplicate' },
    not_found: { status: 404, code: 'not_found' },
    not_suspended: { status: 409, code: 'conflict' },
    conflict: { status: 409, code: 'conflict' },
    indeterminate: { status: 503, code: 'unavailable' },
  } satisfies Record<ServicePrincipalError, ServiceErrorMapping>,
  TokenRevokeError: {
    unauthenticated: { status: 401, code: 'unauthorized' },
    forbidden: { status: 403, code: 'forbidden' },
    not_found: { status: 404, code: 'not_found' },
    indeterminate: { status: 503, code: 'unavailable' },
  } satisfies Record<TokenRevokeError, ServiceErrorMapping>,
  ProjectListError: {
    forbidden: { status: 403, code: 'forbidden' },
    invalid_limit: { status: 400, code: 'invalid_request' },
    invalid_cursor: { status: 400, code: 'invalid_request' },
    invalid_status: { status: 400, code: 'invalid_request' },
    invalid_query: { status: 400, code: 'invalid_request' },
    source_invalid: { status: 503, code: 'unavailable' },
  } satisfies Record<ProjectListError, ServiceErrorMapping>,
} as const;

export function revisionEtag(revision: number): string {
  return `"r${revision}"`;
}

export function jsonResponse(status: number, body: unknown, options?: { etag?: number }): Response {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  if (options?.etag !== undefined) headers.set('ETag', revisionEtag(options.etag));
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

export function apiError(
  code: ApiErrorCode,
  requestId: string,
  details?: readonly ValidationDetail[],
): Response {
  if (!Object.hasOwn(API_ERROR_CODES, code)) throw new TypeError('Unknown API error code');
  const { status, message } = API_ERROR_CODES[code];
  return jsonResponse(status, errorEnvelope(code, message, requestId, details));
}
