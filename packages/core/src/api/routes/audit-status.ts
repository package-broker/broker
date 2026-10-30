import * as z from 'zod';
import type { OrgContext } from '../../db/port.js';
import { AUDIT_ALERT_CODES, type AuditHealth } from '../../audit/health.js';
import { apiRoute } from '../route.js';

export function auditHealthRoutes(reader?: { read(ctx: OrgContext): Promise<AuditHealth> }) {
  return [
    apiRoute(
      {
        method: 'GET',
        path: '/_pb/audit/health',
        permission: 'org:audit:read',
        boundary: 'organization',
        api: {
          operationId: 'getAuditHealth',
          summary: 'Read audit health',
          tags: ['audit'],
          responses: {
            200: z
              .object({
                status: z.enum(['ok', 'degraded', 'failing']),
                codes: z.array(z.enum(AUDIT_ALERT_CODES)),
              })
              .strict(),
          },
        },
      },
      async ({ ctx }) => {
        if (ctx.org === null) throw new TypeError('route requires an organization context');
        if (reader === undefined) return { error: 'audit_trail_unavailable' };
        const health = await reader.read(ctx.org);
        return { status: 200, body: { status: health.status, codes: [...health.codes] } };
      },
    ),
  ];
}
