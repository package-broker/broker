import type { AccessCheckInput, HookMap } from '../plugin.js';

export type HookErrorHandler = (event: {
  readonly plugin: string;
  readonly error: unknown;
}) => void;

export interface AccessCheckOptions {
  /** A hook whose promise has not settled by then counts as hook_error. Default 1000. */
  readonly hookTimeoutMs?: number;
}

type AccessDenial = { readonly deny: true; readonly reason: string };

const DEFAULT_HOOK_TIMEOUT_MS = 1000;
const MAX_HOOK_TIMEOUT_MS = 2_147_483_647;
const MAX_REASON_LENGTH = 200;
const RESERVED_REASONS: ReadonlySet<string> = new Set(['hook_error', 'invalid_hook_result']);

const INVALID: AccessDenial = Object.freeze({ deny: true, reason: 'invalid_hook_result' });
const HOOK_ERROR: AccessDenial = Object.freeze({ deny: true, reason: 'hook_error' });

export class HookTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`access.check hook did not settle within ${String(timeoutMs)} ms`);
    this.name = 'HookTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function frozenCopy<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value))
    return Object.freeze(value.map((entry: unknown) => frozenCopy(entry))) as T;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = frozenCopy(entry);
  return Object.freeze(copy) as T;
}

function dataValue(target: object, key: string): { readonly value: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return { value: descriptor.value as unknown };
}

function isAsciiControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
}

function sanitizeReason(raw: string): string {
  const reason = Array.from(raw)
    .filter((char) => !isAsciiControl(char))
    .join('');
  const normalized = reason.trim().toLowerCase();
  if (normalized === '' || RESERVED_REASONS.has(normalized)) return 'denied';
  if (reason.length <= MAX_REASON_LENGTH) return reason;
  const cut = reason.slice(0, MAX_REASON_LENGTH);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * Any value other than undefined denies. A proxy cannot be detected portably, so its traps
 * (and any accessor) may run here, but they can only choose the denial reason, never grant.
 */
function evaluate(result: unknown): AccessDenial | undefined {
  if (result === undefined) return undefined;
  if (typeof result !== 'object' || result === null) return INVALID;

  try {
    if (Array.isArray(result) || Object.getPrototypeOf(result) !== Object.prototype) return INVALID;

    const keys = Reflect.ownKeys(result);
    if (keys.length === 0 || keys.length > 2) return INVALID;
    if (!keys.every((key) => key === 'deny' || key === 'reason')) return INVALID;

    const deny = dataValue(result, 'deny');
    if (deny === undefined || deny.value !== true) return INVALID;

    if (keys.length === 1) return Object.freeze({ deny: true, reason: 'denied' });

    const reason = dataValue(result, 'reason');
    if (reason === undefined || typeof reason.value !== 'string') return INVALID;
    return Object.freeze({ deny: true, reason: sanitizeReason(reason.value) });
  } catch {
    return INVALID;
  }
}

async function settle(pending: Promise<unknown>, timeoutMs: number): Promise<unknown> {
  const adopted = (async () => await pending)();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new HookTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([adopted, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function hookTimeout(options: AccessCheckOptions): number {
  const value: unknown = options.hookTimeoutMs;
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 1 &&
    value <= MAX_HOOK_TIMEOUT_MS
    ? value
    : DEFAULT_HOOK_TIMEOUT_MS;
}

function isNativePromise(value: unknown): value is Promise<unknown> {
  try {
    return value instanceof Promise;
  } catch {
    return false;
  }
}

function report(onHookError: HookErrorHandler | undefined, plugin: string, error: unknown): void {
  if (onHookError === undefined) return;
  try {
    const pending = (onHookError as (event: { plugin: string; error: unknown }) => unknown)({
      plugin,
      error,
    });
    void Promise.resolve(pending).catch(() => undefined);
  } catch {
    return;
  }
}

/**
 * Runs access.check hooks in order; the first denial wins. The returned reason is for logs and
 * audit only: callers must never send it to clients. `input` must be plain acyclic data; an input
 * that cannot be copied (a cycle, a throwing getter) denies with hook_error.
 */
export async function runAccessChecks(
  hooks: ReadonlyArray<{ readonly plugin: string; readonly handler: HookMap['access.check'] }>,
  input: AccessCheckInput,
  onHookError?: HookErrorHandler,
  options: AccessCheckOptions = {},
): Promise<{ readonly deny: true; readonly reason: string } | undefined> {
  const chain = hooks.map(({ plugin, handler }) => ({ plugin, handler }));
  let snapshot: AccessCheckInput;
  let timeoutMs: number;
  try {
    snapshot = frozenCopy(input);
    timeoutMs = hookTimeout(options);
  } catch {
    return HOOK_ERROR;
  }

  for (const { plugin, handler } of chain) {
    let result: unknown;
    try {
      result = handler(frozenCopy(snapshot));
    } catch (error) {
      report(onHookError, plugin, error);
      return HOOK_ERROR;
    }

    if (isNativePromise(result)) {
      try {
        result = await settle(result, timeoutMs);
      } catch (error) {
        report(onHookError, plugin, error);
        return HOOK_ERROR;
      }
    }

    const denial = evaluate(result);
    if (denial !== undefined) return denial;
  }
  return undefined;
}
