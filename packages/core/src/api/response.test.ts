import type { SourceError } from '../sources/source-service.js';
import type { VisibilityResult } from '../catalogue/visibility-service.js';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AdminError } from '../authz/administration.js';
import type { ProjectError } from '../authz/project-service.js';
import type { PersonalTokenError } from '../authz/pat-service.js';
import type { ServiceTokenError } from '../authz/service-token-service.js';
import type { ServicePrincipalError } from '../authz/service-principal-service.js';
import type { TokenRevokeError } from '../authz/token-revoke.js';
import type { ProjectListError } from '../authz/project-list.js';
import {
  API_ERROR_CODES,
  SERVICE_ERROR_TABLE,
  apiError,
  jsonResponse,
  type ApiErrorCode,
} from './response.js';

const statuses = {
  invalid_unpublish: 400,
  unpublish_window: 409,
  invalid_dist_tag: 400,
  invalid_deprecation: 400,
  deprecation_too_long: 400,
  unpublish_blocked: 409,
  github_credentials_required: 409,
  source_not_attached: 409,
  invalid_version: 400,
  invalid_attachments: 400,
  invalid_attachment: 400,
  provenance_unsupported: 400,
  integrity_mismatch: 400,
  invalid_tarball: 400,
  manifest_mismatch: 400,
  license_missing: 400,
  too_many_tags: 400,
  token_required: 401,
  scope: 403,
  not_admitted: 403,
  self_approval: 403,
  already_decided: 409,
  package_binding: 403,
  no_trusted_publisher: 403,
  claim_in_use: 409,
  claim_overlap: 409,
  name_public: 409,
  name_public_unverified: 409,
  name_not_claimed: 409,
  version_exists: 409,
  publish_gate: 409,
  too_many_sessions: 409,
  ambiguous_trusted_publisher: 409,
  manifest_too_large: 413,
  tarball_too_large: 413,
  write_unsupported: 405,
  busy: 503,
  length_required: 411,
  staging_failed: 503,
  invalid_publish_body: 400,
  unsupported_package: 400,
  unsupported_source_kind: 400,
  package_not_found: 404,
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  local_auth_disabled: 403,
  reauth_required: 403,
  not_found: 404,
  conflict: 409,
  source_paused: 409,
  duplicate: 409,
  last_holder: 409,
  idempotency_mismatch: 409,
  already_issued: 409,
  not_approved: 409,
  precondition_failed: 412,
  precondition_required: 428,
  payload_too_large: 413,
  unsupported_media_type: 415,
  not_acceptable: 406,
  bad_gateway: 502,
  gone: 410,
  upstream_refused: 502,
  unavailable: 503,
} as const;

const expectedCodes: Record<string, ApiErrorCode> = {
  credential_scope_mismatch: 'not_found',
  proxy_source: 'invalid_request',
  pattern_taken: 'conflict',
  claim_in_use: 'claim_in_use',
  claim_overlap: 'claim_overlap',
  name_public: 'name_public',
  name_public_unverified: 'name_public_unverified',
  activation_requires_registered_names: 'conflict',
  has_packages: 'conflict',
  has_history: 'conflict',
  unknown_provider: 'invalid_request',
  role_scope_mismatch: 'invalid_request',
  project_mismatch: 'invalid_request',
  reserved_slug: 'invalid_request',
  initial_role_not_allowed: 'invalid_request',
  scope_conflict: 'invalid_request',
  no_changes: 'invalid_request',
  unauthenticated: 'unauthorized',
  forbidden: 'forbidden',
  reauth_required: 'reauth_required',
  not_found: 'not_found',
  duplicate: 'duplicate',
  last_holder: 'last_holder',
  conflict: 'conflict',
  source_paused: 'source_paused',
  locked: 'conflict',
  system_role: 'conflict',
  in_use: 'conflict',
  archived: 'conflict',
  wrong_state: 'conflict',
  not_suspended: 'conflict',
  indeterminate: 'unavailable',
  source_invalid: 'unavailable',
};

describe('AdminError', () => {
  const members = [
    'invalid_permission',
    'invalid_key',
    'invalid_name',
    'invalid_subject',
    'unknown_provider',
    'locked',
    'system_role',
    'in_use',
    'duplicate',
    'role_scope_mismatch',
    'last_holder',
    'not_found',
    'conflict',
    'invalid_revision',
    'indeterminate',
    'forbidden',
  ] as const satisfies readonly AdminError[];
  it('covers every member with the specified code and status', () => {
    expectTypeOf<Exclude<AdminError, (typeof members)[number]>>().toEqualTypeOf<never>();
    expect(Object.keys(SERVICE_ERROR_TABLE.AdminError).sort()).toEqual([...members].sort());
    for (const member of members) {
      const code = member.startsWith('invalid_') ? 'invalid_request' : expectedCodes[member];
      expect(code).toBeDefined();
      expect(SERVICE_ERROR_TABLE.AdminError[member]).toEqual({ code, status: statuses[code!] });
      expect(Object.hasOwn(API_ERROR_CODES, SERVICE_ERROR_TABLE.AdminError[member].code)).toBe(
        true,
      );
    }
  });
  it('maps indeterminate to unavailable without retrying', () => {
    expect(SERVICE_ERROR_TABLE.AdminError.indeterminate).toEqual({
      status: 503,
      code: 'unavailable',
    });
  });
});

describe('ProjectError', () => {
  const members = [
    'forbidden',
    'reauth_required',
    'invalid_name',
    'invalid_scope',
    'invalid_policy',
    'invalid_revision',
    'invalid_slug',
    'reserved_slug',
    'initial_role_not_allowed',
    'duplicate',
    'no_changes',
    'archived',
    'wrong_state',
    'not_found',
    'conflict',
    'indeterminate',
  ] as const satisfies readonly ProjectError[];
  it('covers every member with the specified code and status', () => {
    expectTypeOf<Exclude<ProjectError, (typeof members)[number]>>().toEqualTypeOf<never>();
    expect(Object.keys(SERVICE_ERROR_TABLE.ProjectError).sort()).toEqual([...members].sort());
    for (const member of members) {
      const code = member.startsWith('invalid_') ? 'invalid_request' : expectedCodes[member];
      expect(code).toBeDefined();
      expect(SERVICE_ERROR_TABLE.ProjectError[member]).toEqual({ code, status: statuses[code!] });
      expect(Object.hasOwn(API_ERROR_CODES, SERVICE_ERROR_TABLE.ProjectError[member].code)).toBe(
        true,
      );
    }
  });
  it('maps indeterminate to unavailable without retrying', () => {
    expect(SERVICE_ERROR_TABLE.ProjectError.indeterminate).toEqual({
      status: 503,
      code: 'unavailable',
    });
  });
});

describe('PersonalTokenError', () => {
  const members = [
    'reauth_required',
    'invalid_name',
    'invalid_scope',
    'scope_conflict',
    'invalid_expiry',
    'invalid_projects',
    'forbidden',
    'conflict',
    'indeterminate',
  ] as const satisfies readonly PersonalTokenError[];
  it('covers every member with the specified code and status', () => {
    expectTypeOf<Exclude<PersonalTokenError, (typeof members)[number]>>().toEqualTypeOf<never>();
    expect(Object.keys(SERVICE_ERROR_TABLE.PersonalTokenError).sort()).toEqual([...members].sort());
    for (const member of members) {
      const code = member.startsWith('invalid_') ? 'invalid_request' : expectedCodes[member];
      expect(code).toBeDefined();
      expect(SERVICE_ERROR_TABLE.PersonalTokenError[member]).toEqual({
        code,
        status: statuses[code!],
      });
      expect(
        Object.hasOwn(API_ERROR_CODES, SERVICE_ERROR_TABLE.PersonalTokenError[member].code),
      ).toBe(true);
    }
  });
  it('maps indeterminate to unavailable without retrying', () => {
    expect(SERVICE_ERROR_TABLE.PersonalTokenError.indeterminate).toEqual({
      status: 503,
      code: 'unavailable',
    });
  });
});

describe('ServiceTokenError', () => {
  const members = [
    'reauth_required',
    'invalid_name',
    'invalid_scope',
    'scope_conflict',
    'invalid_expiry',
    'forbidden',
    'not_found',
    'conflict',
    'indeterminate',
  ] as const satisfies readonly ServiceTokenError[];
  it('covers every member with the specified code and status', () => {
    expectTypeOf<Exclude<ServiceTokenError, (typeof members)[number]>>().toEqualTypeOf<never>();
    expect(Object.keys(SERVICE_ERROR_TABLE.ServiceTokenError).sort()).toEqual([...members].sort());
    for (const member of members) {
      const code = member.startsWith('invalid_') ? 'invalid_request' : expectedCodes[member];
      expect(code).toBeDefined();
      expect(SERVICE_ERROR_TABLE.ServiceTokenError[member]).toEqual({
        code,
        status: statuses[code!],
      });
      expect(
        Object.hasOwn(API_ERROR_CODES, SERVICE_ERROR_TABLE.ServiceTokenError[member].code),
      ).toBe(true);
    }
  });
  it('maps indeterminate to unavailable without retrying', () => {
    expect(SERVICE_ERROR_TABLE.ServiceTokenError.indeterminate).toEqual({
      status: 503,
      code: 'unavailable',
    });
  });
});

describe('ServicePrincipalError', () => {
  const members = [
    'reauth_required',
    'forbidden',
    'invalid_name',
    'invalid_permission',
    'invalid_revision',
    'project_mismatch',
    'duplicate',
    'not_found',
    'not_suspended',
    'conflict',
    'indeterminate',
  ] as const satisfies readonly ServicePrincipalError[];
  it('covers every member with the specified code and status', () => {
    expectTypeOf<Exclude<ServicePrincipalError, (typeof members)[number]>>().toEqualTypeOf<never>();
    expect(Object.keys(SERVICE_ERROR_TABLE.ServicePrincipalError).sort()).toEqual(
      [...members].sort(),
    );
    for (const member of members) {
      const code = member.startsWith('invalid_') ? 'invalid_request' : expectedCodes[member];
      expect(code).toBeDefined();
      expect(SERVICE_ERROR_TABLE.ServicePrincipalError[member]).toEqual({
        code,
        status: statuses[code!],
      });
      expect(
        Object.hasOwn(API_ERROR_CODES, SERVICE_ERROR_TABLE.ServicePrincipalError[member].code),
      ).toBe(true);
    }
  });
  it('maps indeterminate to unavailable without retrying', () => {
    expect(SERVICE_ERROR_TABLE.ServicePrincipalError.indeterminate).toEqual({
      status: 503,
      code: 'unavailable',
    });
  });
});

describe('TokenRevokeError', () => {
  const members = [
    'unauthenticated',
    'forbidden',
    'not_found',
    'indeterminate',
  ] as const satisfies readonly TokenRevokeError[];
  it('covers every member with the specified code and status', () => {
    expectTypeOf<Exclude<TokenRevokeError, (typeof members)[number]>>().toEqualTypeOf<never>();
    expect(Object.keys(SERVICE_ERROR_TABLE.TokenRevokeError).sort()).toEqual([...members].sort());
    for (const member of members) {
      const code = member.startsWith('invalid_') ? 'invalid_request' : expectedCodes[member];
      expect(code).toBeDefined();
      expect(SERVICE_ERROR_TABLE.TokenRevokeError[member]).toEqual({
        code,
        status: statuses[code!],
      });
      expect(
        Object.hasOwn(API_ERROR_CODES, SERVICE_ERROR_TABLE.TokenRevokeError[member].code),
      ).toBe(true);
    }
  });
  it('maps indeterminate to unavailable without retrying', () => {
    expect(SERVICE_ERROR_TABLE.TokenRevokeError.indeterminate).toEqual({
      status: 503,
      code: 'unavailable',
    });
  });
});

describe('ProjectListError', () => {
  const members = [
    'forbidden',
    'invalid_limit',
    'invalid_cursor',
    'invalid_status',
    'invalid_query',
    'source_invalid',
  ] as const satisfies readonly ProjectListError[];
  it('covers every member with the specified code and status', () => {
    expectTypeOf<Exclude<ProjectListError, (typeof members)[number]>>().toEqualTypeOf<never>();
    expect(Object.keys(SERVICE_ERROR_TABLE.ProjectListError).sort()).toEqual([...members].sort());
    for (const member of members) {
      const code = member.startsWith('invalid_') ? 'invalid_request' : expectedCodes[member];
      expect(code).toBeDefined();
      expect(SERVICE_ERROR_TABLE.ProjectListError[member]).toEqual({
        code,
        status: statuses[code!],
      });
      expect(
        Object.hasOwn(API_ERROR_CODES, SERVICE_ERROR_TABLE.ProjectListError[member].code),
      ).toBe(true);
    }
  });
});

describe('SourceError', () => {
  const members = [
    'source_paused',
    'forbidden',
    'not_found',
    'invalid_config',
    'credential_scope_mismatch',
    'duplicate',
    'conflict',
    'indeterminate',
    'activation_requires_registered_names',
    'has_packages',
    'has_history',
    'invalid_pattern',
    'proxy_source',
    'pattern_taken',
    'claim_in_use',
    'claim_overlap',
    'name_public',
    'name_public_unverified',
    'invalid_name',
  ] as const satisfies readonly SourceError[];
  it('covers every member with the specified code and status', () => {
    expectTypeOf<Exclude<SourceError, (typeof members)[number]>>().toEqualTypeOf<never>();
    expect(Object.keys(SERVICE_ERROR_TABLE.SourceError).sort()).toEqual([...members].sort());
    for (const member of members) {
      const code = member.startsWith('invalid_') ? 'invalid_request' : expectedCodes[member];
      expect(code).toBeDefined();
      expect(SERVICE_ERROR_TABLE.SourceError[member]).toEqual({
        code,
        status: statuses[code!],
      });
      expect(Object.hasOwn(API_ERROR_CODES, SERVICE_ERROR_TABLE.SourceError[member].code)).toBe(
        true,
      );
    }
  });
});

describe('response helpers', () => {
  it('has exactly the closed code list and specified statuses', async () => {
    expect(Object.keys(API_ERROR_CODES).sort()).toEqual(Object.keys(statuses).sort());
    for (const code of Object.keys(statuses) as ApiErrorCode[]) {
      const response = apiError(code, 'r');
      expect(response.status).toBe(statuses[code]);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-type')).toBe('application/json');
      expect([...response.headers.keys()].some((key) => key.startsWith('access-control-'))).toBe(
        false,
      );
      expect(await response.json()).toEqual({
        error: { code, message: API_ERROR_CODES[code].message, requestId: 'r' },
      });
    }
  });

  it('rejects an unknown error code', () => {
    expect(() => apiError('unknown' as ApiErrorCode, 'r')).toThrow(TypeError);
  });

  it('rejects an inherited property as an error code', () => {
    expect(() => apiError('toString' as ApiErrorCode, 'r')).toThrow(TypeError);
  });

  it('keeps messages fixed and isolates details between calls', async () => {
    const codes = Object.keys(statuses) as ApiErrorCode[];
    for (const code of codes) {
      const sentinel = `/sentinel-${code}`;
      const withDetails = await apiError(code, 'r', [{ path: sentinel, code: 'invalid' }]).json();
      expect(withDetails).toEqual({
        error: {
          code,
          message: API_ERROR_CODES[code].message,
          requestId: 'r',
          details: [{ path: sentinel, code: 'invalid' }],
        },
      });
      expect(API_ERROR_CODES[code].message).not.toContain(sentinel);
      for (const other of codes.filter((candidate) => candidate !== code)) {
        expect(await apiError(other, 'r').text()).not.toContain(sentinel);
      }
    }
  });

  it('caps API validation details at twenty entries', async () => {
    const details = Array.from({ length: 21 }, () => ({ path: '/name', code: 'invalid' as const }));
    expect(await apiError('invalid_request', 'r', details).json()).toMatchObject({
      error: { details: details.slice(0, 20) },
    });
  });

  it('returns JSON with private response headers and an optional revision ETag', async () => {
    const response = jsonResponse(200, { ok: true }, { etag: 3 });
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect([...response.headers.keys()].some((key) => key.startsWith('access-control-'))).toBe(
      false,
    );
    expect(response.headers.get('etag')).toBe('"r3"');
    expect(await response.json()).toEqual({ ok: true });
    expect(jsonResponse(200, {}).headers.has('etag')).toBe(false);
  });

  it('returns no body for 204 even when a body was supplied', async () => {
    const response = jsonResponse(204, { ignored: true }, { etag: 0 });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('');
    expect(response.headers.get('etag')).toBe('"r0"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json');
  });
});

describe('VisibilityError', () => {
  const codes = {
    forbidden: 'forbidden',
    collision: 'conflict',
    conflict: 'conflict',
    not_found: 'not_found',
    not_attached: 'not_found',
    unclassified: 'unavailable',
    invalid_pattern: 'invalid_request',
    too_many_patterns: 'invalid_request',
    not_eligible: 'conflict',
  } as const;
  it('covers every visibility error with an existing code and status', () => {
    expectTypeOf<keyof typeof codes>().toEqualTypeOf<
      Extract<VisibilityResult, { ok: false }>['error']
    >();
    expect(Object.keys(SERVICE_ERROR_TABLE.VisibilityError).sort()).toEqual(
      Object.keys(codes).sort(),
    );
    for (const member of Object.keys(codes) as (keyof typeof codes)[]) {
      const code = codes[member];
      expect(SERVICE_ERROR_TABLE.VisibilityError[member]).toEqual({ code, status: statuses[code] });
      expect(Object.hasOwn(API_ERROR_CODES, code)).toBe(true);
    }
  });
});

describe('npm error messages', () => {
  it('appends new error codes after the existing catalogue', () => {
    const codes = Object.keys(API_ERROR_CODES);
    expect(codes[0]).toBe('unsupported_package');
    expect(codes.indexOf('invalid_version')).toBe(codes.indexOf('unavailable') + 1);
    expect(API_ERROR_CODES.claim_overlap.message).toBe(
      'This package name is already published or proxied',
    );
    expect(API_ERROR_CODES.token_required.message).toBe('A token is required to publish');
    expect(API_ERROR_CODES.publish_gate.message).toBe(
      'Approval is required before this version can be released',
    );
  });
});
