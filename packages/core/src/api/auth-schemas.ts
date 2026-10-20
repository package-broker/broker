import * as z from 'zod';
import type { ApiSlot } from '../plugin.js';

const field = z.string().max(1024);
const providerParams = z.strictObject({ provider: z.string() });

export const authProvidersResponse = z.strictObject({
  providers: z.array(
    z.strictObject({
      id: z.string(),
      kind: z.enum(['cloudflare-access', 'oidc']),
      displayName: z.string(),
      supportsReauth: z.boolean(),
    }),
  ),
  local: z.boolean(),
});
export const ssoStartBody = z.strictObject({
  purpose: z.enum(['login', 'reauth']),
  returnTo: z.string().optional(),
});
export const ssoStartResponse = z.strictObject({ location: z.string() });
export const localSetupStartBody = z.strictObject({ token: field });
export const localSetupStartResponse = z.strictObject({
  provisioningUri: z.string(),
  secret: z.string(),
});
export const localSetupFinishBody = z.strictObject({ token: field, password: field, code: field });
export const localLoginBody = z.strictObject({ email: field, password: field, code: field });
export const localReauthBody = z.strictObject({ password: field, code: field });
export const sessionResponse = z.strictObject({
  user: z.strictObject({ id: z.string(), email: z.string(), displayName: z.string().nullable() }),
  reauthFresh: z.boolean(),
  expiresAt: z.string(),
});

export const AUTH_API: Readonly<Record<string, ApiSlot>> = Object.freeze({
  'GET /_pb/auth/providers': {
    operationId: 'listAuthProviders',
    summary: 'List the sign-in methods',
    tags: ['auth'],
    responses: { 200: authProvidersResponse },
  },
  'POST /_pb/auth/sso/:provider/start': {
    operationId: 'startSsoLogin',
    summary: 'Start a single sign-on login or re-authentication',
    tags: ['auth'],
    params: providerParams,
    body: ssoStartBody,
    responses: { 200: ssoStartResponse, 303: null, 401: null, 403: null, 502: null },
  },
  'GET /_pb/auth/sso/:provider/callback': {
    operationId: 'finishSsoLogin',
    summary: 'Finish a single sign-on login or re-authentication',
    tags: ['auth'],
    params: providerParams,
    responses: { 303: null, 401: null },
  },
  'POST /_pb/auth/local/setup/start': {
    operationId: 'startLocalSetup',
    summary: 'Start the local login setup',
    tags: ['auth'],
    body: localSetupStartBody,
    responses: { 200: localSetupStartResponse, 401: null, 403: null },
  },
  'POST /_pb/auth/local/setup/finish': {
    operationId: 'finishLocalSetup',
    summary: 'Finish the local login setup and sign in',
    tags: ['auth'],
    body: localSetupFinishBody,
    responses: { 204: null, 401: null, 403: null },
  },
  'POST /_pb/auth/local/login': {
    operationId: 'localLogin',
    summary: 'Sign in with the local login',
    tags: ['auth'],
    body: localLoginBody,
    responses: { 204: null, 401: null, 403: null },
  },
  'POST /_pb/auth/local/reauth': {
    operationId: 'localReauth',
    summary: 'Re-authenticate with the local login',
    tags: ['auth'],
    body: localReauthBody,
    responses: { 204: null, 401: null, 403: null },
  },
  'POST /_pb/auth/logout': {
    operationId: 'logout',
    summary: 'End the current session',
    tags: ['session'],
    responses: { 204: null, 401: null, 403: null },
  },
  'GET /_pb/session': {
    operationId: 'getSession',
    summary: 'Get the current session',
    tags: ['session'],
    responses: { 200: sessionResponse, 401: null },
  },
});
