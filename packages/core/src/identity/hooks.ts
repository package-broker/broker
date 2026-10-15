import { frozenCopy, invokeHook, runDenyHooks } from '../kernel/access.js';
import type { AccessCheckOptions, DenyCode, HookErrorHandler } from '../kernel/access.js';
import type { Registration } from '../kernel/registry.js';
import type { HookMap } from '../plugin.js';

const CORE_PLUGIN = 'core';

type IdentityDenial<C extends DenyCode | 'invalid_input'> = {
  readonly deny: true;
  readonly plugin: string;
  readonly code: C;
};

function denial<C extends DenyCode | 'invalid_input'>(plugin: string, code: C): IdentityDenial<C> {
  return Object.freeze({ deny: true, plugin, code });
}

/** The hook's free-text reason is dropped: only the plugin id and a fixed code leave this module. */
export async function runResolveIdentityHooks(
  hooks: Registration['hooks']['auth.resolveIdentity'],
  input: Parameters<HookMap['auth.resolveIdentity']>[0],
  onHookError?: HookErrorHandler,
  options?: AccessCheckOptions,
): Promise<IdentityDenial<'denied' | 'invalid_hook_result' | 'hook_error'> | undefined> {
  const outcome = await runDenyHooks(hooks, input, onHookError, options);
  if (outcome === undefined) return undefined;
  return denial(outcome.plugin ?? CORE_PLUGIN, outcome.code);
}

function narrow(result: unknown, current: readonly string[]): readonly string[] | undefined {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined;
  const keys = Reflect.ownKeys(result);
  if (keys.length !== 1 || keys[0] !== 'keep') return undefined;

  const keep: unknown = (result as { readonly keep: unknown }).keep;
  if (!Array.isArray(keep) || keep.length > current.length) return undefined;

  const allowed = new Set(current);
  const kept = new Set<string>();
  for (const entry of keep as unknown[]) {
    if (typeof entry !== 'string' || !allowed.has(entry)) return undefined;
    kept.add(entry);
  }
  return current.filter((group) => kept.has(group));
}

function dataValue(target: object, key: string): { readonly value: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return { value: descriptor.value as unknown };
}

function startingGroups(groups: unknown): readonly string[] | undefined {
  if (!Array.isArray(groups)) return undefined;
  const length = dataValue(groups, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return undefined;

  const list: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = dataValue(groups, String(index));
    if (entry === undefined || typeof entry.value !== 'string') return undefined;
    list.push(entry.value);
  }
  return new Set(list).size === list.length ? Object.freeze(list) : undefined;
}

/**
 * Each hook sees the groups the previous one left. A hook can only narrow: undefined keeps, and
 * `{ keep }` must list groups already present, at most as many as are present. Anything else
 * denies. An input that cannot be copied denies as `hook_error`, a starting list that is not an
 * array of distinct strings as `invalid_input` (its elements are read through own data
 * descriptors, never through an iterator); both are attributed to `core`.
 */
export async function runMapGroupsHooks(
  hooks: Registration['hooks']['auth.mapGroups'],
  input: Parameters<HookMap['auth.mapGroups']>[0],
  onHookError?: HookErrorHandler,
  options?: AccessCheckOptions,
): Promise<
  | { readonly groups: readonly string[] }
  | IdentityDenial<'invalid_hook_result' | 'hook_error' | 'invalid_input'>
> {
  let snapshot: Omit<Parameters<HookMap['auth.mapGroups']>[0], 'groups'>;
  let hookTimeoutMs: number | undefined;
  let start: readonly string[] | undefined;
  try {
    const { groups, ...rest } = input;
    snapshot = frozenCopy(rest);
    start = startingGroups(groups);
    hookTimeoutMs = options?.hookTimeoutMs;
  } catch {
    return denial(CORE_PLUGIN, 'hook_error');
  }
  if (start === undefined) return denial(CORE_PLUGIN, 'invalid_input');

  const chain = hooks.map(({ plugin, handler }) => ({ plugin, handler }));
  let groups: readonly string[] = start;
  for (const { plugin, handler } of chain) {
    const invocation = await invokeHook(
      handler,
      { ...snapshot, groups },
      { plugin, onHookError, hookTimeoutMs },
    );
    if (!invocation.ok) return denial(plugin, 'hook_error');
    if (invocation.value === undefined) continue;

    const narrowed = narrow(invocation.value, groups);
    if (narrowed === undefined) return denial(plugin, 'invalid_hook_result');
    groups = Object.freeze(narrowed);
  }
  return Object.freeze({ groups });
}
