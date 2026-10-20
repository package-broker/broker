import { parseAuthorization } from '../auth/credential-parser.js';
import { accessContextOf } from '../authz/access-context.js';
import { envelopeResponse } from '../kernel/errors.js';
import type { RequestContext } from '../plugin.js';

export function mcpGate(ctx: RequestContext, publicOrigin: string): Response | null {
  const credential = parseAuthorization(ctx.request.headers.get('authorization'));
  const access = accessContextOf(ctx);
  if (
    credential.outcome !== 'token' ||
    credential.scheme !== 'bearer' ||
    access === null ||
    access.principal === null ||
    access.sessionId !== null
  ) {
    return envelopeResponse(401, 'unauthorized', 'Unauthorized', ctx.requestId);
  }

  const origin = ctx.request.headers.get('origin');
  if (
    access.token?.scope !== 'read' ||
    credential.token.kind !== access.token.kind ||
    !(
      (access.principal.kind === 'user' && access.token.kind === 'pat') ||
      (access.principal.kind === 'service' && access.token.kind === 'svc')
    ) ||
    (origin !== null && origin !== publicOrigin)
  ) {
    return envelopeResponse(403, 'forbidden', 'Access denied', ctx.requestId);
  }
  return null;
}
