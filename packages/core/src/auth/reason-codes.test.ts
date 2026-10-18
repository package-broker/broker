import { describe, expect, it } from 'vitest';
import {
  AUTH_REASON_CODES,
  IDENTITY_FAILURES,
  LOGIN_REFUSALS,
  REAUTH_REFUSALS,
  START_FAILURE_DETAILS,
} from './reason-codes.js';

describe('auth reason sets', () => {
  it('pins START_FAILURE_DETAILS', () => {
    expect([...START_FAILURE_DETAILS].sort()).toEqual([
      'callback_invalid',
      'discovery_bad_json',
      'discovery_content_type',
      'discovery_failed',
      'discovery_invalid',
      'discovery_network',
      'discovery_redirect',
      'discovery_status',
      'discovery_timeout',
      'discovery_too_large',
      'purpose_invalid',
      'secret_missing',
    ]);
  });

  it('pins IDENTITY_FAILURES', () => {
    expect([...IDENTITY_FAILURES].sort()).toEqual([
      'email_missing',
      'invalid_token',
      'missing_credentials',
      'provider_error',
      'state_mismatch',
    ]);
  });

  it('pins LOGIN_REFUSALS', () => {
    expect([...LOGIN_REFUSALS].sort()).toEqual([
      'already_linked',
      'conflict',
      'domain_not_verified',
      'email_changed',
      'email_missing',
      'email_unverified',
      'hook_denied',
      'invalid_identity',
      'link_requires_admin',
      'not_invited',
      'provider_rebound',
      'too_many_groups',
      'user_suspended',
    ]);
  });

  it('pins REAUTH_REFUSALS', () => {
    expect([...REAUTH_REFUSALS].sort()).toEqual([
      'hook_denied',
      'identity_mismatch',
      'no_auth_time',
      'not_sso_session',
      'not_supported',
      'not_updated',
      'policy',
      'stale_auth_time',
      'state_mismatch',
    ]);
  });

  it('pins AUTH_REASON_CODES', () => {
    expect([...AUTH_REASON_CODES].sort()).toEqual([
      'already_linked',
      'attempts',
      'callback_invalid',
      'conflict',
      'cross_site',
      'direct_reauth',
      'discovery_bad_json',
      'discovery_content_type',
      'discovery_failed',
      'discovery_invalid',
      'discovery_network',
      'discovery_redirect',
      'discovery_status',
      'discovery_timeout',
      'discovery_too_large',
      'domain_not_verified',
      'email_changed',
      'email_missing',
      'email_unverified',
      'hook_denied',
      'identity_mismatch',
      'invalid_identity',
      'invalid_token',
      'link_requires_admin',
      'login_refused',
      'missing_credentials',
      'no_auth_time',
      'no_session',
      'not_invited',
      'not_sso_session',
      'not_supported',
      'not_updated',
      'origin_mismatch',
      'origin_missing',
      'policy',
      'provider_error',
      'provider_rebound',
      'purpose_invalid',
      'reauth_refused',
      'secret_missing',
      'stale_auth_time',
      'state_invalid',
      'state_mismatch',
      'token_mismatch',
      'token_missing',
      'too_many_groups',
      'user_suspended',
    ]);
  });
});
