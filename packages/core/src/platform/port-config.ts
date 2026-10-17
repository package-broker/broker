import type { Platform } from '../plugin.js';
import { DEFAULT_MAX_BLOB_BYTES } from './blob.js';
import { looksLikeCredential } from './credential.js';

export const MAX_JOBS_RUNNING = 2;
export const MAX_CACHE_BYTES = 32 * 1024 * 1024;
export const MAX_ENV_NAME_LENGTH = 48;
export const MAX_IDENTIFIER_LENGTH = 64;

export interface BlobPortConfig {
  adapter: 'r2' | 'filesystem' | 's3';
  binding?: string;
  rootEnv?: string;
  endpointEnv?: string;
  regionEnv?: string;
  bucketEnv?: string;
  accessKeyIdEnv?: string;
  secretAccessKeyEnv?: string;
  sessionTokenEnv?: string;
  pathStyle?: boolean;
  maxBytes: number;
}

export interface CachePortConfig {
  adapter: 'cache-api' | 'lru';
  namespace?: string;
  maxBytes?: number;
}

export interface JobsPortConfig {
  adapter: 'queues' | 'database';
  binding?: string;
  maxRunning: number;
}

export interface ObservabilityPortConfig {
  adapter: 'workers' | 'stdio';
  analyticsBinding?: string;
  deploymentIdEnv: 'DEPLOYMENT_ID';
  endpointEnv?: string;
  headersEnv?: string;
}

export interface PlatformPortConfig {
  blob: BlobPortConfig;
  cache: CachePortConfig;
  jobs: JobsPortConfig;
  observability: ObservabilityPortConfig;
}

const ADAPTERS: Record<Platform, Record<keyof PlatformPortConfig, readonly string[]>> = {
  cloudflare: {
    blob: ['r2'],
    cache: ['cache-api'],
    jobs: ['queues'],
    observability: ['workers'],
  },
  node: {
    blob: ['filesystem', 's3'],
    cache: ['lru'],
    jobs: ['database'],
    observability: ['stdio'],
  },
};

type PortName = keyof PlatformPortConfig;

const ALLOWED: Record<PortName, Record<string, readonly string[]>> = {
  blob: {
    r2: ['adapter', 'binding', 'maxBytes'],
    filesystem: ['adapter', 'rootEnv', 'maxBytes'],
    s3: [
      'adapter',
      'endpointEnv',
      'regionEnv',
      'bucketEnv',
      'accessKeyIdEnv',
      'secretAccessKeyEnv',
      'sessionTokenEnv',
      'pathStyle',
      'maxBytes',
    ],
  },
  cache: {
    'cache-api': ['adapter', 'namespace'],
    lru: ['adapter', 'maxBytes'],
  },
  jobs: {
    queues: ['adapter', 'binding', 'maxRunning'],
    database: ['adapter', 'maxRunning'],
  },
  observability: {
    workers: ['adapter', 'analyticsBinding', 'deploymentIdEnv', 'endpointEnv', 'headersEnv'],
    stdio: ['adapter', 'deploymentIdEnv', 'endpointEnv', 'headersEnv'],
  },
};

const ALL_KEYS: Record<PortName, readonly string[]> = {
  blob: [
    'adapter',
    'binding',
    'rootEnv',
    'endpointEnv',
    'regionEnv',
    'bucketEnv',
    'accessKeyIdEnv',
    'secretAccessKeyEnv',
    'sessionTokenEnv',
    'pathStyle',
    'maxBytes',
  ],
  cache: ['adapter', 'namespace', 'maxBytes'],
  jobs: ['adapter', 'binding', 'maxRunning'],
  observability: ['adapter', 'analyticsBinding', 'deploymentIdEnv', 'endpointEnv', 'headersEnv'],
};

const BLOB_ENV_KEYS = [
  'rootEnv',
  'endpointEnv',
  'regionEnv',
  'bucketEnv',
  'accessKeyIdEnv',
  'secretAccessKeyEnv',
  'sessionTokenEnv',
];
const S3_REQUIRED = [
  'endpointEnv',
  'regionEnv',
  'bucketEnv',
  'accessKeyIdEnv',
  'secretAccessKeyEnv',
];
const RESERVED_WORKER_NAMES = ['DB', 'DEPLOYMENT_ID'];

const ENV_NAME = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
const BINDING_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const NAMESPACE = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_KEY = /^[A-Za-z0-9_.-]+$/;

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(object: Obj, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function safeKey(key: string): string {
  if (key.length > MAX_IDENTIFIER_LENGTH || !SAFE_KEY.test(key) || looksLikeCredential(key)) {
    return '<redacted>';
  }
  return key;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validateStanza(stanza: Obj, target: Platform, prefix: string): string[] {
  const problems: string[] = [];
  const envSeen = new Set<string>(['DEPLOYMENT_ID']);
  const names = new Set<string>(target === 'cloudflare' ? RESERVED_WORKER_NAMES : []);

  for (const key of Object.keys(stanza)) {
    if (!Object.hasOwn(ADAPTERS[target], key))
      problems.push(`${prefix}${safeKey(key)}: unknown key`);
  }

  function section(name: PortName): Obj | undefined {
    const value = own(stanza, name);
    if (value === undefined) {
      problems.push(`${prefix}${name}: required`);
      return undefined;
    }
    if (!isObject(value)) {
      problems.push(`${prefix}${name}: must be an object`);
      return undefined;
    }
    const adapter = own(value, 'adapter');
    const allowedAdapters = ADAPTERS[target][name];
    const valid = typeof adapter === 'string' && allowedAdapters.includes(adapter);
    if (!valid) {
      problems.push(
        `${prefix}${name}.adapter: must be one of ${allowedAdapters.join(', ')} for ${target}`,
      );
    }
    for (const key of Object.keys(value)) {
      if (!ALL_KEYS[name].includes(key)) {
        problems.push(`${prefix}${name}.${safeKey(key)}: unknown key`);
      } else if (valid && !ALLOWED[name][adapter]?.includes(key)) {
        problems.push(`${prefix}${name}.${key}: not used by ${adapter}`);
      }
    }
    return value;
  }

  function envRef(name: string, object: Obj, key: string, required = false): void {
    const value = own(object, key);
    const at = `${prefix}${name}.${key}`;
    if (value === undefined) {
      if (required) problems.push(`${at}: required`);
      return;
    }
    if (typeof value !== 'string' || value.length > MAX_ENV_NAME_LENGTH || !ENV_NAME.test(value)) {
      problems.push(`${at}: invalid env reference name`);
      return;
    }
    if (looksLikeCredential(value)) {
      problems.push(`${at}: looks like a credential value, expected an env reference name`);
      return;
    }
    if (envSeen.has(value) || names.has(value)) {
      problems.push(`${at}: duplicate env reference name`);
      return;
    }
    envSeen.add(value);
    if (target === 'cloudflare') names.add(value);
  }

  function binding(name: string, object: Obj, key: string, required = false): void {
    const value = own(object, key);
    const at = `${prefix}${name}.${key}`;
    if (value === undefined) {
      if (required) problems.push(`${at}: required`);
      return;
    }
    if (
      typeof value !== 'string' ||
      value.length > MAX_IDENTIFIER_LENGTH ||
      !BINDING_NAME.test(value)
    ) {
      problems.push(`${at}: invalid identifier`);
      return;
    }
    if (RESERVED_WORKER_NAMES.includes(value) && target === 'cloudflare') {
      problems.push(`${at}: reserved binding name`);
      return;
    }
    if (names.has(value)) problems.push(`${at}: duplicate binding name`);
    names.add(value);
  }

  const blob = section('blob');
  if (blob) {
    const maxBytes = own(blob, 'maxBytes');
    if (!positiveInteger(maxBytes)) {
      problems.push(`${prefix}blob.maxBytes: must be a positive integer`);
    } else if (maxBytes > DEFAULT_MAX_BLOB_BYTES) {
      problems.push(`${prefix}blob.maxBytes: exceeds the product cap`);
    }
    const pathStyle = own(blob, 'pathStyle');
    if (pathStyle !== undefined && typeof pathStyle !== 'boolean') {
      problems.push(`${prefix}blob.pathStyle: must be a boolean`);
    }
    const adapter = own(blob, 'adapter');
    binding('blob', blob, 'binding', adapter === 'r2');
    for (const key of BLOB_ENV_KEYS) {
      const required =
        adapter === 'filesystem'
          ? key === 'rootEnv'
          : adapter === 's3' && S3_REQUIRED.includes(key);
      envRef('blob', blob, key, required);
    }
  }

  const cache = section('cache');
  if (cache) {
    const namespace = own(cache, 'namespace');
    if (
      namespace !== undefined &&
      (typeof namespace !== 'string' ||
        namespace.length > MAX_IDENTIFIER_LENGTH ||
        !NAMESPACE.test(namespace))
    ) {
      problems.push(`${prefix}cache.namespace: invalid identifier`);
    }
    const maxBytes = own(cache, 'maxBytes');
    if (maxBytes !== undefined) {
      if (!positiveInteger(maxBytes)) {
        problems.push(`${prefix}cache.maxBytes: must be a positive integer`);
      } else if (maxBytes > MAX_CACHE_BYTES) {
        problems.push(`${prefix}cache.maxBytes: exceeds the cache cap`);
      }
    }
  }

  const jobs = section('jobs');
  if (jobs) {
    const maxRunning = own(jobs, 'maxRunning');
    if (!positiveInteger(maxRunning)) {
      problems.push(`${prefix}jobs.maxRunning: must be a positive integer`);
    } else if (maxRunning > MAX_JOBS_RUNNING) {
      problems.push(`${prefix}jobs.maxRunning: exceeds the jobs cap`);
    }
    binding('jobs', jobs, 'binding', own(jobs, 'adapter') === 'queues');
  }

  const observability = section('observability');
  if (observability) {
    if (own(observability, 'deploymentIdEnv') !== 'DEPLOYMENT_ID') {
      problems.push(`${prefix}observability.deploymentIdEnv: must be DEPLOYMENT_ID`);
    }
    binding('observability', observability, 'analyticsBinding');
    envRef('observability', observability, 'endpointEnv');
    envRef('observability', observability, 'headersEnv');
    if (
      own(observability, 'headersEnv') !== undefined &&
      own(observability, 'endpointEnv') === undefined
    ) {
      problems.push(`${prefix}observability.headersEnv: requires endpointEnv`);
    }
  }

  return problems;
}

export function validatePlatformPorts(input: unknown, target: Platform): readonly string[] {
  if (!Object.hasOwn(ADAPTERS, target)) return ['target: unknown platform'];
  if (input === undefined) return [];
  if (!isObject(input)) return ['platformPorts: must be an object'];

  const problems: string[] = [];
  for (const key of Object.keys(input)) {
    const prefix = `${safeKey(key)}.`;
    if (!Object.hasOwn(ADAPTERS, key)) {
      problems.push(`${safeKey(key)}: unknown key`);
      continue;
    }
    const stanza = input[key];
    if (!isObject(stanza)) {
      problems.push(`${key}: must be an object`);
    } else {
      problems.push(...validateStanza(stanza, key as Platform, prefix));
    }
  }
  return problems;
}
