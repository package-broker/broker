import { observability, platformPorts, plugins } from '#pb-manifest';
import type { BrokerConfig } from '@package-broker/core/config';
import { createWorker } from './index.js';

declare module '#pb-manifest' {
  export const observability: BrokerConfig['observability'];
}

export default createWorker(plugins, { platformPorts, observability });
