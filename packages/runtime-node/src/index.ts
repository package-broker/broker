import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { errorEnvelope } from '@package-broker/core';
import type { PluginDefinition } from '@package-broker/core/plugin';

export interface NodeBroker {
  readonly plugins: readonly PluginDefinition[];
  readonly server: Server;
}

export function createNodeServer(plugins: readonly PluginDefinition[]): NodeBroker {
  const server = createServer((_request, response) => {
    const requestId = randomUUID();
    response.writeHead(404, { 'content-type': 'application/json', 'x-request-id': requestId });
    response.end(JSON.stringify(errorEnvelope('not_found', 'Route not found', requestId)));
  });
  return { plugins, server };
}
