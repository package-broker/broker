import type { OrgContext } from '../../db/port.js';
import { discoveryRuleRoutes, type DiscoveryRuleRouteDeps } from './discovery-rules.js';
import type { BulkDiscovery } from '../../sources/bulk-discovery.js';
import { apiRoute, type ApiOutcome } from '../route.js';
import { callContext, type ApiRouteDeps } from './context.js';
import { SOURCE_DISCOVERY_API_SPECS } from './source-discovery-schemas.js';

function failure(error: string): ApiOutcome {
  if (error === 'forbidden') return { error: 'forbidden' };
  if (error === 'credential_not_found') return { error: 'not_found' };
  if (['invalid_request', 'invalid_repositories', 'too_many_repositories'].includes(error))
    return { error: 'invalid_request' };
  return { error: 'unavailable' };
}

export function sourceDiscoveryRoutes(
  deps: ApiRouteDeps & {
    readonly discovery: BulkDiscovery;
    readonly connections: {
      list(ctx: OrgContext): Promise<
        readonly {
          credentialId: string;
          installationId: number;
          sourceNames: string[];
          sourceCount: number;
        }[]
      >;
    };
    readonly savedRules?: DiscoveryRuleRouteDeps;
  },
) {
  return [
    ...(deps.savedRules === undefined ? [] : discoveryRuleRoutes(deps.savedRules)),
    apiRoute(SOURCE_DISCOVERY_API_SPECS[2], async ({ ctx }) => {
      const c = callContext(ctx, deps);
      return { status: 200, body: { items: await deps.connections.list(c.org) } };
    }),
    apiRoute(SOURCE_DISCOVERY_API_SPECS[0], async ({ ctx, body }) => {
      const c = callContext(ctx, deps);
      const result = await deps.discovery.dryRun(c.org, c.actor, {
        credentialId: body.credentialId,
        installationId: body.installationId,
        includeForks: body.includeForks === true,
        ...(body.ecosystem === undefined ? {} : { ecosystem: body.ecosystem }),
        pattern: body.pattern,
        cursor: body.cursor,
      });
      return result.ok ? { status: 200, body: result.value } : failure(result.error);
    }),
    apiRoute(SOURCE_DISCOVERY_API_SPECS[1], async ({ ctx, body }) => {
      const c = callContext(ctx, deps);
      const result = await deps.discovery.apply(
        c.org,
        c.actor,
        c.fence,
        {
          credentialId: body.credentialId,
          installationId: body.installationId,
          includeForks: body.includeForks === true,
          ...(body.ecosystem === undefined ? {} : { ecosystem: body.ecosystem }),
          repositories: body.repositories,
          nextCursor: body.nextCursor ?? null,
        },
        c.call,
      );
      return result.ok ? { status: 200, body: result.value } : failure(result.error);
    }),
  ];
}
