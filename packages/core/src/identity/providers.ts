import { reportableErrorName } from '../kernel/error-name.js';
import { KernelConfigError, type Registration } from '../kernel/registry.js';
import type { PluginDefinition } from '../plugin.js';
import { copyIndexed, providerFieldProblems, readLength } from './provider-fields.js';
import { ENV_PREFIX } from './secret-name.js';
import { type DomainPolicy, type IdentityContext, type IdentityProvider } from './port.js';

export { PROVIDER_SECRET_SUFFIXES, providerSecretName } from './secret-name.js';

const UNRESERVED_CHARACTER = /^[A-Za-z0-9\-._~]$/;
const MAX_QUOTED_LENGTH = 80;
const MAX_PROVIDERS = 64;

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
      const { policy, byField } = providerFieldProblems({
        id,
        kind,
        displayName,
        trustAnchor,
        policy: source.policy,
      });
      const appendProblems = (messages: readonly string[]): void => {
        problems.push(...messages.map((problem) => `${label} ${problem}`));
      };
      appendProblems(byField.id);
      if (byField.id.length === 0 && typeof id === 'string') {
        if (idIndex.has(id)) {
          problems.push(`${label} id ${quoted(id)} duplicates provider[${idIndex.get(id)}]`);
        } else {
          idIndex.set(id, index);
        }
      }
      appendProblems(byField.kind);
      appendProblems(byField.trustAnchor);
      if (byField.trustAnchor.length === 0 && typeof trustAnchor === 'string') {
        const key = canonicalAnchor(trustAnchor);
        if (anchorIndex.has(key)) {
          problems.push(`${label} trustAnchor duplicates provider[${anchorIndex.get(key)}]`);
        } else {
          anchorIndex.set(key, index);
        }
      }
      appendProblems(byField.displayName);
      appendProblems(byField.kindPrefix);
      appendProblems(byField.policy);
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
