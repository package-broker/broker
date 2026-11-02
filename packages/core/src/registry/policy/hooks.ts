import { DEFAULT_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS } from '../../kernel/access.js';
import type {
  ClientHints,
  HookMap,
  PackageEcosystem,
  ReadKind,
  ReadPolicyInput,
  ReadPolicyReason,
  VersionFact,
} from '../../plugin.js';
import { RegistryPolicyUnavailableError } from './errors.js';

export const HOOK_CANDIDATE_BATCH = 64;

export interface RegisteredReadHook {
  readonly plugin: string;
  readonly handler: HookMap['registry.read'];
}

/** The already authorized request a hook sees; no headers, token, e-mail or URL. */
export interface HookContext {
  readonly orgId: string;
  readonly projectId: string;
  readonly principal: Readonly<{ kind: 'user' | 'service' | 'customer'; id: string }>;
  readonly ecosystem: PackageEcosystem;
  readonly client: ClientHints;
  readonly now: string;
}

export type HookFailureCode = 'hook_error' | 'invalid_hook_result' | 'hook_timeout';

export interface HookBudget {
  remainingMs(): number;
  /** Internal: runs one call under the remaining budget and charges its duration. */
  readonly run: <T>(
    plugin: string,
    call: (signal: AbortSignal) => T | PromiseLike<T>,
  ) => Promise<T>;
  readonly fail: (plugin: string, code: HookFailureCode) => never;
}

export interface HookBudgetOptions {
  /** One budget for every hook call of a request; defaults to the access-hook default. */
  readonly budgetMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly onFailure?: (event: { readonly plugin: string; readonly code: HookFailureCode }) => void;
}

export interface HookRequestDenial {
  readonly plugin: string;
  readonly reason: ReadPolicyReason;
}

export interface HookVersionDenial {
  readonly plugin: string;
  readonly versionId: string;
  readonly revision: number;
  readonly reason: ReadPolicyReason;
}

const REASONS: ReadonlySet<unknown> = new Set(['restricted', 'client_unsupported']);
const INVALID = Symbol('invalid');

class HookCallError extends Error {
  constructor(readonly code: HookFailureCode) {
    super(code);
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function createHookBudget(options: HookBudgetOptions = {}): HookBudget {
  const budgetMs = options.budgetMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  if (
    typeof budgetMs !== 'number' ||
    !Number.isSafeInteger(budgetMs) ||
    budgetMs < 1 ||
    budgetMs > MAX_HOOK_TIMEOUT_MS
  ) {
    throw new TypeError('hook budget must be an integer number of milliseconds');
  }
  const now = options.now ?? Date.now;
  const request = options.signal;
  let spent = 0;
  const remainingMs = () => Math.max(0, budgetMs - spent);
  const fail = (plugin: string, code: HookFailureCode): never => {
    try {
      options.onFailure?.({ plugin, code });
    } catch {
      // A telemetry failure must not change the fixed outcome.
    }
    throw new RegistryPolicyUnavailableError();
  };

  async function run<T>(
    plugin: string,
    call: (signal: AbortSignal) => T | PromiseLike<T>,
  ): Promise<T> {
    const remaining = remainingMs();
    if (remaining <= 0 || request?.aborted === true) return fail(plugin, 'hook_timeout');
    const controller = new AbortController();
    const started = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort();
    request?.addEventListener('abort', abort, { once: true });
    try {
      let result: unknown;
      try {
        result = call(controller.signal);
      } catch {
        throw new HookCallError('hook_error');
      }
      if (isThenable(result)) {
        const pending = result;
        result = await new Promise<unknown>((resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new HookCallError('hook_timeout'));
          }, remaining);
          controller.signal.addEventListener(
            'abort',
            () => reject(new HookCallError('hook_timeout')),
            {
              once: true,
            },
          );
          try {
            pending.then(resolve, () => reject(new HookCallError('hook_error')));
          } catch {
            reject(new HookCallError('hook_error'));
          }
        });
      }
      if (now() - started >= remaining) throw new HookCallError('hook_timeout');
      return result as T;
    } catch (error) {
      return fail(plugin, error instanceof HookCallError ? error.code : 'hook_error');
    } finally {
      clearTimeout(timer);
      request?.removeEventListener('abort', abort);
      spent += Math.max(0, now() - started);
    }
  }

  return { remainingMs, run, fail };
}

function data(target: object, key: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined || !('value' in descriptor)) throw INVALID;
  return descriptor.value as unknown;
}

function plainKeys(value: unknown, prototype: object): readonly (string | symbol)[] {
  if (typeof value !== 'object' || value === null || Reflect.getPrototypeOf(value) !== prototype) {
    throw INVALID;
  }
  return Reflect.ownKeys(value);
}

function sameKeys(keys: readonly (string | symbol)[], expected: readonly string[]): boolean {
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

type Decoded =
  | { readonly kind: 'abstain' }
  | { readonly kind: 'deny'; readonly reason: ReadPolicyReason }
  | { readonly kind: 'versions'; readonly denied: readonly Omit<HookVersionDenial, 'plugin'>[] };

const ABSTAIN: Decoded = { kind: 'abstain' };

/** Own data properties of plain objects only, exact key sets, fixed reasons, known candidates. */
function decode(result: unknown, candidates: ReadonlyMap<string, number> | null): Decoded {
  if (result === undefined) return ABSTAIN;
  const keys = plainKeys(result, Object.prototype);
  if (sameKeys(keys, ['deny', 'reason'])) {
    const reason = data(result as object, 'reason');
    if (data(result as object, 'deny') !== true || !REASONS.has(reason)) throw INVALID;
    return { kind: 'deny', reason: reason as ReadPolicyReason };
  }
  if (candidates === null || !sameKeys(keys, ['deniedVersions'])) throw INVALID;
  const list = data(result as object, 'deniedVersions');
  const listKeys = plainKeys(list, Array.prototype);
  const length = data(list as object, 'length');
  if (typeof length !== 'number' || length > candidates.size || listKeys.length !== length + 1) {
    throw INVALID;
  }
  const denied: Omit<HookVersionDenial, 'plugin'>[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const entry = data(list as object, String(index));
    if (!sameKeys(plainKeys(entry, Object.prototype), ['versionId', 'revision', 'reason'])) {
      throw INVALID;
    }
    const versionId = data(entry as object, 'versionId');
    const revision = data(entry as object, 'revision');
    const reason = data(entry as object, 'reason');
    if (
      typeof versionId !== 'string' ||
      seen.has(versionId) ||
      candidates.get(versionId) !== revision ||
      !REASONS.has(reason)
    ) {
      throw INVALID;
    }
    seen.add(versionId);
    denied.push({ versionId, revision: revision as number, reason: reason as ReadPolicyReason });
  }
  return denied.length === 0 ? ABSTAIN : { kind: 'versions', denied };
}

function base(context: HookContext, signal: AbortSignal) {
  return {
    org: Object.freeze({ orgId: context.orgId }),
    projectId: context.projectId,
    principal: Object.freeze({ kind: context.principal.kind, id: context.principal.id }),
    ecosystem: context.ecosystem,
    client: Object.freeze({ family: context.client.family, version: context.client.version }),
    now: context.now,
    signal,
  };
}

function frozenFact(fact: VersionFact): VersionFact {
  return Object.freeze({
    packageId: fact.packageId,
    sourceId: fact.sourceId,
    packageKey: fact.packageKey,
    versionId: fact.versionId,
    version: fact.version,
    normalizedVersion: fact.normalizedVersion,
    revision: fact.revision,
    publishedAt: fact.publishedAt,
    ageBasis: fact.ageBasis,
  });
}

async function invoke(
  hook: RegisteredReadHook,
  budget: HookBudget,
  input: (signal: AbortSignal) => ReadPolicyInput,
  candidates: ReadonlyMap<string, number> | null,
): Promise<Decoded> {
  const handler = hook.handler;
  const result = await budget.run(hook.plugin, (signal) => handler(input(signal)));
  try {
    return decode(result, candidates);
  } catch {
    return budget.fail(hook.plugin, 'invalid_hook_result');
  }
}

/** Request-wide restrictions, in compiled order; the first denial ends the request. */
export async function runRequestHooks(
  hooks: readonly RegisteredReadHook[],
  context: HookContext,
  request: { readonly kind: ReadKind; readonly packageKey: string | null },
  budget: HookBudget,
): Promise<HookRequestDenial | null> {
  for (const hook of hooks) {
    const decoded = await invoke(
      hook,
      budget,
      (signal) =>
        Object.freeze({
          ...base(context, signal),
          phase: 'request' as const,
          kind: request.kind,
          packageKey: request.packageKey,
        }),
      null,
    );
    if (decoded.kind === 'deny') return { plugin: hook.plugin, reason: decoded.reason };
  }
  return null;
}

/**
 * Bounded calls over authorized candidates that survived the built-ins. Denials accumulate and a
 * later hook only sees what earlier hooks left, so no hook can restore a denied candidate.
 */
export async function runVersionHooks(
  hooks: readonly RegisteredReadHook[],
  context: HookContext,
  facts: readonly VersionFact[],
  budget: HookBudget,
): Promise<{
  readonly request: HookRequestDenial | null;
  readonly denied: readonly HookVersionDenial[];
}> {
  const denied: HookVersionDenial[] = [];
  if (hooks.length === 0) return { request: null, denied };
  // A hook names a denial by version id, so one id at two revisions could not be told apart.
  if (new Set(facts.map((fact) => fact.versionId)).size !== facts.length) {
    throw new RegistryPolicyUnavailableError();
  }
  const refused = new Set<string>();
  for (let offset = 0; offset < facts.length; offset += HOOK_CANDIDATE_BATCH) {
    const page = facts.slice(offset, offset + HOOK_CANDIDATE_BATCH);
    for (const hook of hooks) {
      const open = page.filter((fact) => !refused.has(fact.versionId));
      if (open.length === 0) break;
      const candidates = new Map(open.map((fact) => [fact.versionId, fact.revision]));
      const decoded = await invoke(
        hook,
        budget,
        (signal) =>
          Object.freeze({
            ...base(context, signal),
            phase: 'versions' as const,
            versions: Object.freeze(open.map(frozenFact)),
          }),
        candidates,
      );
      if (decoded.kind === 'deny') {
        return { request: { plugin: hook.plugin, reason: decoded.reason }, denied };
      }
      if (decoded.kind !== 'versions') continue;
      for (const entry of decoded.denied) {
        refused.add(entry.versionId);
        denied.push({ plugin: hook.plugin, ...entry });
      }
    }
  }
  return { request: null, denied };
}
