import { observability, platformPorts, plugins, registry, tokens } from '#pb-manifest';
import type { BrokerConfig } from '@package-broker/core/config';
import { createWorker } from './index.js';

declare module '#pb-manifest' {
  export const observability: BrokerConfig['observability'];
}

export default createWorker(plugins, {
  platformPorts,
  observability,
  ...(registry === undefined ? {} : { registry }),
  ...(tokens === undefined ? {} : { tokens }),
});
