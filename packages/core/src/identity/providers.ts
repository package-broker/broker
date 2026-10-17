import { reportableErrorName } from '../kernel/error-name.js';
import { KernelConfigError, type Registration } from '../kernel/registry.js';
import type { PluginDefinition } from '../plugin.js';
import { domainPolicyProblems } from './policy.js';
import {
  isReservedProviderId,
  isValidProviderId,
  isValidTrustAnchor,
  type DomainPolicy,
  type IdentityContext,
  type IdentityProvider,
} from './port.js';

const ENV_PREFIX = 'PB_IDP_';
export const PROVIDER_SECRET_SUFFIXES: readonly string[] = Object.freeze([
  'CLIENT_ID',
  'CLIENT_SECRET',
]);
const UNSAFE_DISPLAY_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const UNRESERVED_CHARACTER = /^[A-Za-z0-9\-._~]$/;
const MAX_QUOTED_LENGTH = 80;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_PROVIDERS = 64;
const MAX_DOMAINS = 100;
const PROVIDER_KINDS: readonly string[] = ['cloudflare-access', 'oidc'];

export interface ProviderMap {
  get(id: string): IdentityProvider | undefined;
  has(id: string): boolean;
  keys(): IterableIterator<string>;
  values(): IterableIterator<IdentityProvider>;
  readonly size: number;
}

export function scopedEnv(
  env: Readonly<Record<string, unknown>>,
): (name: string) => string | undefined {
  return (name) => {
    if (typeof name !== 'string') {
      return undefined;
    }
    if (!name.startsWith(ENV_PREFIX) || !Object.hasOwn(env, name)) {
      return undefined;
    }
    const value = env[name];
    return typeof value === 'string' ? value : undefined;
  };
}

export function scopedReader(read: (name: string) => string | undefined) {
  return (name: string): string | undefined => {
    if (typeof name !== 'string' || !name.startsWith(ENV_PREFIX)) {
      return undefined;
    }
    const value: unknown = read(name);
    return typeof value === 'string' ? value : undefined;
  };
}

export function providerSecretName(providerId: string, suffix: string): string {
  if (!isValidProviderId(providerId) || isReservedProviderId(providerId)) {
    throw new RangeError('provider id is not valid for a secret name');
  }
  if (!PROVIDER_SECRET_SUFFIXES.includes(suffix)) {
    throw new RangeError(`secret suffix must be one of ${PROVIDER_SECRET_SUFFIXES.join(', ')}`);
  }
  return `${ENV_PREFIX}${providerId.toUpperCase().replaceAll('-', '_')}_${suffix}`;
}

function quoted(value: string): string {
  return JSON.stringify(value.slice(0, MAX_QUOTED_LENGTH));
}

function canonicalAnchor(anchor: string): string {
  if (!anchor.startsWith('oidc:')) {
    return anchor.toLowerCase();
  }
  try {
    const url = new URL(anchor.slice('oidc:'.length));
    const path = url.pathname
      .replace(/%([0-9a-fA-F]{2})/g, (escape, hex: string) => {
        const char = String.fromCharCode(Number.parseInt(hex, 16));
        return UNRESERVED_CHARACTER.test(char) ? char : escape.toUpperCase();
      })
      .replace(/\/+$/, '');
    const host = url.hostname.replace(/\.$/, '');
    return `oidc:${url.protocol}//${host}${url.port === '' ? '' : `:${url.port}`}${path}`;
  } catch {
    return anchor;
  }
}

function readLength(list: readonly unknown[]): number | null {
  const length: unknown = list.length;
  return typeof length === 'number' && Number.isSafeInteger(length) && length >= 0 ? length : null;
}

function copyIndexed(list: readonly unknown[], length: number): unknown[] {
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
    let value: unknown;
    if (descriptor !== undefined) {
      value =
        'value' in descriptor
          ? descriptor.value
          : descriptor.get === undefined
            ? undefined
            : Reflect.apply(descriptor.get, list, []);
    }
    Object.defineProperty(items, index, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return items;
}

function snapshotPolicy(raw: unknown): {
  readonly policy: DomainPolicy;
  readonly problems: string[];
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { policy: raw as DomainPolicy, problems: domainPolicyProblems(raw as DomainPolicy) };
  }
  const source = raw as {
    verifiedDomains?: unknown;
    emailAuthoritativeDomains?: unknown;
    autoJoin?: unknown;
  };
  const snapshot: Record<string, unknown> = {};
  for (const key of ['verifiedDomains', 'emailAuthoritativeDomains'] as const) {
    const domains = source[key];
    if (Array.isArray(domains)) {
      const length = readLength(domains as unknown[]);
      if (length === null || length > MAX_DOMAINS) {
        return {
          policy: { verifiedDomains: [], autoJoin: false },
          problems: [`${key} must be an array of at most ${MAX_DOMAINS} entries`],
        };
      }
      snapshot[key] = copyIndexed(domains as unknown[], length);
    } else {
      snapshot[key] = domains;
    }
  }
  const policy = { ...snapshot, autoJoin: source.autoJoin } as unknown as DomainPolicy;
  return { policy, problems: domainPolicyProblems(policy) };
}

function ignore(): void {}

type Collected = { readonly items: readonly unknown[] } | { readonly problem: string };

function collectResult(
  factory: (ctx: IdentityContext) => unknown,
  ctx: IdentityContext,
  prefix: string,
): Collected {
  let phase = 'threw';
  try {
    const result = factory(ctx);
    phase = 'result threw';
    if ((typeof result === 'object' || typeof result === 'function') && result !== null) {
      const then: unknown = (result as { then?: unknown }).then;
      if (typeof then === 'function') {
        Promise.resolve(result).catch(ignore);
        return { problem: `${prefix} identity factory must return an array` };
      }
    }
    if (!Array.isArray(result)) {
      return { problem: `${prefix} identity factory must return an array` };
    }
    const list = result as unknown[];
    const length = readLength(list);
    if (length === null) {
      return { problem: `${prefix} identity factory must return an array` };
    }
    if (length > MAX_PROVIDERS) {
      return {
        problem: `${prefix} identity factory returned more than ${MAX_PROVIDERS} providers`,
      };
    }
    const items = copyIndexed(list, length);
    return { items };
  } catch (error) {
    return { problem: `${prefix} identity factory ${phase} ${reportableErrorName(error)}` };
  }
}

function wrap(
  source: IdentityProvider,
  fields: Pick<IdentityProvider, 'id' | 'kind' | 'displayName' | 'trustAnchor' | 'supportsReauth'>,
  policy: DomainPolicy,
  start: IdentityProvider['start'],
  finish: IdentityProvider['finish'],
): IdentityProvider {
  return Object.freeze({
    ...fields,
    policy: Object.freeze({
      verifiedDomains: Object.freeze(policy.verifiedDomains.slice()),
      emailAuthoritativeDomains: Object.freeze((policy.emailAuthoritativeDomains ?? []).slice()),
      autoJoin: policy.autoJoin,
    }),
    start: (input: Parameters<IdentityProvider['start']>[0]) =>
      Reflect.apply(start, source, [input]) as ReturnType<IdentityProvider['start']>,
    finish: (input: Parameters<IdentityProvider['finish']>[0]) =>
      Reflect.apply(finish, source, [input]) as ReturnType<IdentityProvider['finish']>,
  });
}

function readOnlyView(built: ReadonlyMap<string, IdentityProvider>): ProviderMap {
  const entries = new Map(built);
  return Object.freeze({
    get: (id: string) => entries.get(id),
    has: (id: string) => entries.has(id),
    keys: () => entries.keys(),
    values: () => entries.values(),
    get size() {
      return entries.size;
    },
  });
}

export function buildIdentityProviders(
  registration: Registration,
  plugins: readonly PluginDefinition[],
  ctx: IdentityContext,
): ProviderMap {
  const owner = registration.bindings.get('identity');
  if (owner === undefined) {
    return readOnlyView(new Map());
  }
  const prefix = `plugin ${quoted(owner)}`;
  const factory = registration.identityFactory;
  let ownerListed: boolean;
  try {
    ownerListed = plugins.some((plugin) => plugin.id === owner);
  } catch {
    throw new KernelConfigError([`${prefix} could not be matched against the plugin list`]);
  }
  if (factory === null || !ownerListed) {
    throw new KernelConfigError([`${prefix} binds identity but has no identity factory`]);
  }

  const collected = collectResult(
    factory,
    Object.freeze({
      fetch: ctx.fetch,
      clock: Object.freeze({ now: () => ctx.clock.now() }),
      env: scopedReader(ctx.env),
    }),
    prefix,
  );
  if ('problem' in collected) {
    throw new KernelConfigError([collected.problem]);
  }

  const problems: string[] = [];
  const built = new Map<string, IdentityProvider>();
  const idIndex = new Map<string, number>();
  const anchorIndex = new Map<string, number>();

  collected.items.forEach((candidate, index) => {
    const label = `${prefix} identity provider[${index}]`;
    if (typeof candidate !== 'object' || candidate === null) {
      problems.push(`${label} must be an object`);
      return;
    }
    const before = problems.length;
    try {
      const source = candidate as IdentityProvider;
      const id: unknown = source.id;
      const kind: unknown = source.kind;
      const displayName: unknown = source.displayName;
      const trustAnchor: unknown = source.trustAnchor;
      const supportsReauth: unknown = source.supportsReauth;
      const start: unknown = source.start;
      const finish: unknown = source.finish;
      const { policy, problems: policyProblems } = snapshotPolicy(source.policy);

      if (typeof id !== 'string' || !isValidProviderId(id)) {
        problems.push(`${label} id is not a valid provider id (type ${typeof id})`);
      } else if (isReservedProviderId(id)) {
        problems.push(`${label} id ${quoted(id)} is reserved`);
      } else if (idIndex.has(id)) {
        problems.push(`${label} id ${quoted(id)} duplicates provider[${idIndex.get(id)}]`);
      } else {
        idIndex.set(id, index);
      }
      if (typeof kind !== 'string' || !PROVIDER_KINDS.includes(kind)) {
        problems.push(`${label} kind must be "cloudflare-access" or "oidc"`);
      }
      if (typeof trustAnchor !== 'string' || !isValidTrustAnchor(trustAnchor)) {
        problems.push(`${label} trustAnchor is not a valid trust anchor`);
      } else {
        const key = canonicalAnchor(trustAnchor);
        if (anchorIndex.has(key)) {
          problems.push(`${label} trustAnchor duplicates provider[${anchorIndex.get(key)}]`);
        } else {
          anchorIndex.set(key, index);
        }
      }
      if (
        typeof displayName !== 'string' ||
        displayName.length < 1 ||
        displayName.length > MAX_DISPLAY_NAME_LENGTH ||
        UNSAFE_DISPLAY_CHARACTER.test(displayName)
      ) {
        problems.push(
          `${label} displayName must be 1 to ${MAX_DISPLAY_NAME_LENGTH} characters without control or format characters`,
        );
      }
      if (
        typeof kind === 'string' &&
        PROVIDER_KINDS.includes(kind) &&
        typeof trustAnchor === 'string' &&
        isValidTrustAnchor(trustAnchor) &&
        !trustAnchor.startsWith(kind === 'oidc' ? 'oidc:' : 'access:')
      ) {
        problems.push(`${label} kind does not match the trustAnchor prefix`);
      }
      for (const problem of policyProblems) {
        problems.push(`${label} policy: ${problem}`);
      }
      if (typeof supportsReauth !== 'boolean') {
        problems.push(`${label} supportsReauth must be a boolean`);
      }
      if (typeof start !== 'function') {
        problems.push(`${label} start must be a function`);
      }
      if (typeof finish !== 'function') {
        problems.push(`${label} finish must be a function`);
      }
      if (problems.length === before) {
        built.set(
          id as string,
          wrap(
            source,
            {
              id: id as string,
              kind: kind as IdentityProvider['kind'],
              displayName: displayName as string,
              trustAnchor: trustAnchor as string,
              supportsReauth: supportsReauth as boolean,
            },
            policy,
            start as IdentityProvider['start'],
            finish as IdentityProvider['finish'],
          ),
        );
      }
    } catch (error) {
      problems.push(`${label} threw ${reportableErrorName(error)}`);
    }
  });

  if (problems.length > 0) {
    throw new KernelConfigError(problems);
  }
  return readOnlyView(built);
}
