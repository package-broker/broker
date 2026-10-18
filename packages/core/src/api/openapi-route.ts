import type { RouteDefinition } from '../plugin.js';
import type { OpenApiDocument } from './openapi.js';

export function openApiRoute(document: OpenApiDocument): RouteDefinition {
  const body = JSON.stringify(document);
  return {
    method: 'GET',
    path: '/_pb/openapi.json',
    permission: null,
    needsOrg: false,
    api: { exempt: 'openapi document' },
    handler: () =>
      new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      }),
  };
}
