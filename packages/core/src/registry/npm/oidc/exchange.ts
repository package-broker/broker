import { jsonResponse } from '../../../api/response.js';
import type { createWorkloadTokenService } from '../../../authz/service-token-service.js';
import { packageKey } from '../../../catalogue/names.js';
import type { OidcRepository } from '../../../db/oidc.js';
import type { OrgContext } from '../../../db/port.js';
import type { Clock } from '../../../ids.js';
import type { RequestContext, RouteDefinition } from '../../../plugin.js';
import { findTrustedPublisher } from './publisher.js';
import { OidcError, type VerifiedOidcClaims } from './verify.js';

export interface OidcExchangeDependencies {
  readonly verify: (jwt: string, now: number) => Promise<VerifiedOidcClaims>;
  readonly repository: Pick<OidcRepository, 'find' | 'reserveStatements'>;
  readonly tokens: ReturnType<typeof createWorkloadTokenService>;
  readonly organization: () => Promise<OrgContext | null>;
  readonly clock: Clock;
}
function response(ctx: RequestContext, status: number, body: Record<string, unknown>): Response {
  const result = jsonResponse(status, body);
  result.headers.set('Cache-Control', 'no-store');
  result.headers.set('x-request-id', ctx.requestId);
  return result;
}
function refused(ctx: RequestContext, status: number, code: string): Response {
  return response(ctx, status, { error: 'OIDC exchange refused', code, requestId: ctx.requestId });
}
export function createOidcExchangeRoute(deps: OidcExchangeDependencies): RouteDefinition {
  return {
    method: 'POST',
    path: '/-/npm/v1/oidc/token/exchange/package/:name',
    boundary: 'none',
    permission: null,
    needsOrg: false,
    async handler(ctx) {
      try {
        const name = ctx.params['name'] ?? '';
        try {
          packageKey(name, { ecosystem: 'npm' });
        } catch {
          return refused(ctx, 400, 'invalid_name');
        }
        const authorization = ctx.request.headers.get('authorization');
        if (
          !authorization ||
          authorization.length > 8199 ||
          !/^Bearer [A-Za-z0-9._-]+$/i.test(authorization)
        )
          return refused(ctx, 401, 'invalid_oidc_token');
        const claims = await deps.verify(authorization.slice(7), deps.clock.now().getTime());
        const org = await deps.organization();
        if (!org) return refused(ctx, 404, 'not_found');
        const publisher = await findTrustedPublisher(deps.repository, org, name, claims);
        const replay = deps.repository.reserveStatements(org, {
          issuer: claims.issuer,
          jti: claims.jti,
          expiresAt: claims.expiresAt,
          trustedPublisherId: publisher.id,
          expectedRevision: publisher.revision,
          now: deps.clock.now().toISOString(),
        });
        const issued = await deps.tokens.issueWorkload(
          org,
          { publisher, replay },
          {
            requestId: ctx.requestId,
            changes: {
              trusted_publisher_id: { new: publisher.id },
              repository_id: { new: claims.repositoryId },
              repository_owner_id: { new: claims.repositoryOwnerId },
              repository_visibility: { new: claims.repositoryVisibility },
              workflow: { new: claims.workflow },
              environment: { new: claims.environment },
              ref: { new: claims.ref },
              package: { new: name },
            },
          },
        );
        if (issued.status !== 'issued') {
          const unavailable =
            issued.status === 'indeterminate' || issued.reason === 'selector_collision';
          return refused(
            ctx,
            unavailable ? 503 : 403,
            unavailable ? 'unavailable' : 'no_trusted_publisher',
          );
        }
        return response(ctx, 201, {
          token_type: 'oidc',
          token: issued.token,
          created: issued.created,
          expires: issued.expires,
        });
      } catch (error) {
        if (error instanceof OidcError)
          return refused(
            ctx,
            error.code === 'ambiguous_trusted_publisher'
              ? 409
              : error.code === 'no_trusted_publisher'
                ? 403
                : error.code === 'invalid_oidc_token'
                  ? 401
                  : 503,
            error.code === 'invalid_oidc_config' ? 'unavailable' : error.code,
          );
        return refused(ctx, 503, 'unavailable');
      }
    },
  };
}
