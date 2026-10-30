import type { PluginPorts } from '../plugin.js';
import type { CoreBlobStore as BlobStore } from '../platform/blob.js';
import type { Cache } from '../platform/cache.js';
import type { JobInitiator, JobsFactory, JobStore } from '../platform/jobs-port.js';
import type { Observability } from '../platform/observability.js';

/** Unscoped services from the runtime; plugins never receive this object. */
export interface PlatformServices {
  readonly blob: BlobStore;
  readonly cache: Cache;
  readonly jobStore: JobStore;
}

export interface PluginPortBinding {
  readonly pluginId: string;
  readonly observability: Observability;
  readonly initiator: JobInitiator;
}

export function bindPluginPorts(
  base: PluginPorts,
  services: PlatformServices | undefined,
  jobs: JobsFactory | undefined,
  binding: PluginPortBinding,
): PluginPorts {
  if (services === undefined) return base;
  if (jobs === undefined) throw new TypeError('platform services require a jobs factory');
  const { organizations, clock, ids } = base;
  const boundJobs = jobs(binding.pluginId, binding.initiator);
  return Object.freeze({
    organizations,
    clock,
    ids,
    platform: Object.freeze({
      blob: Object.freeze<NonNullable<PluginPorts['platform']>['blob']>({
        put: (...args) => services.blob.put(...args),
        get: (...args) => services.blob.get(...args),
        head: (...args) => services.blob.head(...args),
      }),
      cache: services.cache,
      jobs: Object.freeze<NonNullable<PluginPorts['platform']>['jobs']>({
        enqueue: (...args) => boundJobs.enqueue(...args),
        get: (...args) => boundJobs.get(...args),
        ...(boundJobs.notify === undefined ? {} : { notify: boundJobs.notify.bind(boundJobs) }),
      }),
      observability: binding.observability,
    }),
  });
}
