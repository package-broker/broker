import {
  audit,
  mcp,
  migrations,
  notifications,
  observability,
  platformPorts,
  plugins,
  registry,
  tokens,
  vulnerability,
} from '#pb-manifest';
import type { BrokerConfig } from '@package-broker/core/config';
import { createWorker } from './index.js';

declare module '#pb-manifest' {
  export const observability: BrokerConfig['observability'];
}

const { build_generation: auditGeneration, ...auditConfig } = audit ?? {};

export default createWorker(plugins, {
  auditGeneration: auditGeneration ?? 0,
  platformPorts,
  migrations,
  observability,
  ...(registry === undefined ? {} : { registry }),
  ...(audit === undefined ? {} : { audit: auditConfig }),
  ...(tokens === undefined ? {} : { tokens }),
  ...(vulnerability === undefined ? {} : { vulnerability }),
  ...(mcp === undefined ? {} : { mcp }),
  ...(notifications === undefined ? {} : { notifications }),
});
