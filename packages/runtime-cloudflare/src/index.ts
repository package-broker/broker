import { errorEnvelope } from '@package-broker/core';
import type { PluginDefinition } from '@package-broker/core/plugin';

export interface Worker {
  readonly plugins: readonly PluginDefinition[];
  fetch(request: Request): Promise<Response>;
}

export function createWorker(plugins: readonly PluginDefinition[]): Worker {
  return {
    plugins,
    async fetch() {
      const requestId = crypto.randomUUID();
      return Response.json(errorEnvelope('not_found', 'Route not found', requestId), {
        status: 404,
        headers: { 'x-request-id': requestId },
      });
    },
  };
}
