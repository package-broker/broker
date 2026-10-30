import type { OrgContext } from '@package-broker/core/db/port';
import type { SourceRecord } from '@package-broker/core/db/source';
import type { CoreJobs as Jobs } from '@package-broker/core/platform/jobs';
import type { FetchLike } from '@package-broker/core/platform/tracing';
import type { PluginDefinition } from '@package-broker/core/plugin';
import type { SourceCredential } from '@package-broker/core/registry/module';
import { createNodeServer, type NodeBroker, type NodeServerOptions } from '../index.js';
import { SEAMS_KEY } from '../internal/seams-key.js';
import type { Resolver } from '../sources/dns-guard.js';

export interface CredentialAccessSeam {
  forSource(ctx: OrgContext, record: SourceRecord): Promise<SourceCredential | null>;
}

export interface RegistrySeams {
  readonly transport?: FetchLike;
  readonly resolver?: Resolver;
  readonly jobs?: Jobs;
  readonly observeCredentials?: (access: CredentialAccessSeam) => void;
  readonly shutdownDeadlineMs?: number;
}

export function createNodeServerWithSeams(
  plugins: readonly PluginDefinition[],
  options: NodeServerOptions,
  seams: RegistrySeams,
): NodeBroker {
  const carrier: NodeServerOptions = Object.assign({}, options, { [SEAMS_KEY]: seams });
  return createNodeServer(plugins, carrier);
}
