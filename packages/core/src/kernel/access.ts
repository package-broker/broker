import type { AccessCheckInput, HookMap } from '../plugin.js';

export type HookErrorHandler = (event: {
  readonly plugin: string;
  readonly error: unknown;
}) => void;

export interface AccessCheckOptions {
  /** Hook deadline in ms: a safe integer in 1..600000, otherwise 1000. Expiry is hook_error. */
  readonly hookTimeoutMs?: number;
}

type AccessDenial = { readonly deny: true; readonly reason: string };

const DEFAULT_HOOK_TIMEOUT_MS = 1000;
const MAX_HOOK_TIMEOUT_MS = 600_000;
const MAX_REASON_LENGTH = 200;
const MAX_RESULT_DEPTH = 8;
const MAX_RESULT_ARRAY_LENGTH = 100_000;
const UNSAFE_RESULT = Symbol('unsafe_hook_result');
const RESERVED_REASONS: ReadonlySet<string> = new Set(['hook_error', 'invalid_hook_result']);

const INVALID: AccessDenial = Object.freeze({ deny: true, reason: 'invalid_hook_result' });

export class HookTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`access.check hook did not settle within ${String(timeoutMs)} ms`);
    this.name = 'HookTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export function frozenCopy<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value))
    return Object.freeze(value.map((entry: unknown) => frozenCopy(entry))) as T;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = frozenCopy(entry);
  return Object.freeze(copy) as T;
}

function dataValue(target: object, key: string | symbol): { readonly value: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return { value: descriptor.value as unknown };
}

function snapshotValue(value: unknown, depth: number): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (depth > MAX_RESULT_DEPTH) throw new RangeError('hook result too deep');

  if (Array.isArray(value)) {
    const own = new Map<string | symbol, unknown>();
    for (const key of Reflect.ownKeys(value)) {
      const entry = dataValue(value, key);
      if (entry === undefined) throw new TypeError('hook result array has an accessor property');
      own.set(key, entry.value);
    }
    const length = own.get('length');
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
      throw new TypeError('hook result array has no valid length');
    }
    if (length > MAX_RESULT_ARRAY_LENGTH) throw new RangeError('hook result array too long');
    const items: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!own.has(key)) throw new TypeError('hook result array has a hole');
      items.push(snapshotValue(own.get(key), depth + 1));
    }
    return Object.freeze(items);
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('hook result is not a plain object');
  }
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new TypeError('hook result has a symbol key');
    const entry = dataValue(value, key);
    if (entry === undefined) throw new TypeError('hook result property is not data');
    Object.defineProperty(copy, key, {
      value: snapshotValue(entry.value, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return Object.freeze(copy);
}

/**
 * Own data properties only, each read once, plain objects and arrays only. Anything else (an
 * accessor, a symbol key, a foreign prototype, a throwing proxy trap) becomes a symbol, which no
 * consumer accepts as a valid result.
 */
function snapshotResult(value: unknown): unknown {
  try {
    return snapshotValue(value, 0);
  } catch {
    return UNSAFE_RESULT;
  }
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

function hookTimeout(options: { readonly hookTimeoutMs?: number | undefined }): number {
  const value: unknown = options.hookTimeoutMs;
  return Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_HOOK_TIMEOUT_MS
    ? (value as number)
    : DEFAULT_HOOK_TIMEOUT_MS;
}

function isNativePromise(value: unknown): value is Promise<unknown> {
  try {
    return value instanceof Promise;
  } catch {
    return false;
  }
}

export function reportHookError(
  onHookError: HookErrorHandler | undefined,
  plugin: string,
  error: unknown,
): void {
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

export type HookInvocation =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: 'hook_error' };

const HOOK_FAILED: HookInvocation = Object.freeze({ ok: false, reason: 'hook_error' });

/**
 * Calls one hook on a frozen copy of `input` under the hook deadline and returns a frozen
 * accessor-safe snapshot of its result (see `snapshotResult`); the caller decides what the value
 * means. A throw, a rejection, a timeout or an input that cannot be copied is `{ ok: false }`;
 * throws, rejections and timeouts are also reported to `onHookError`.
 */
export async function invokeHook<I, R>(
  handler: (input: I) => R | Promise<R>,
  input: I,
  options: {
    readonly plugin: string;
    readonly onHookError?: HookErrorHandler | undefined;
    readonly hookTimeoutMs?: number | undefined;
  },
): Promise<HookInvocation> {
  let argument: I;
  let timeoutMs: number;
  try {
    argument = frozenCopy(input);
    timeoutMs = hookTimeout(options);
  } catch {
    return HOOK_FAILED;
  }

  let result: unknown;
  try {
    result = handler(argument);
  } catch (error) {
    reportHookError(options.onHookError, options.plugin, error);
    return HOOK_FAILED;
  }

  if (isNativePromise(result)) {
    try {
      result = await settle(result, timeoutMs);
    } catch (error) {
      reportHookError(options.onHookError, options.plugin, error);
      return HOOK_FAILED;
    }
  }
  return Object.freeze({ ok: true, value: snapshotResult(result) });
}

export type DenyCode = 'denied' | 'invalid_hook_result' | 'hook_error';

/**
 * `reason` is the sanitized access.check reason for the caller's own use. The kernel logs only
 * `code`, never `reason`. Identity hook callers must not forward it: they expose only `plugin`
 * and `code` (C37).
 */
export interface DenyOutcome {
  readonly deny: true;
  readonly reason: string;
  readonly code: DenyCode;
  /** Undefined when the input could not be copied before any hook ran. */
  readonly plugin: string | undefined;
}

/**
 * Runs deny-only hooks in order; the first denial wins. `input` must be plain acyclic data; an
 * input that cannot be copied (a cycle, a throwing getter) denies with hook_error.
 */
export async function runDenyHooks<I>(
  hooks: ReadonlyArray<{ readonly plugin: string; readonly handler: (input: I) => unknown }>,
  input: I,
  onHookError?: HookErrorHandler,
  options: AccessCheckOptions = {},
): Promise<DenyOutcome | undefined> {
  const chain = hooks.map(({ plugin, handler }) => ({ plugin, handler }));
  let snapshot: I;
  let timeoutMs: number;
  try {
    snapshot = frozenCopy(input);
    timeoutMs = hookTimeout(options);
  } catch {
    return { deny: true, reason: 'hook_error', code: 'hook_error', plugin: undefined };
  }

  for (const { plugin, handler } of chain) {
    const invocation = await invokeHook(handler, snapshot, {
      plugin,
      onHookError,
      hookTimeoutMs: timeoutMs,
    });
    if (!invocation.ok) {
      return { deny: true, reason: 'hook_error', code: 'hook_error', plugin };
    }
    const denial = evaluate(invocation.value);
    if (denial === INVALID) {
      return { deny: true, reason: INVALID.reason, code: 'invalid_hook_result', plugin };
    }
    if (denial !== undefined) {
      return { deny: true, reason: denial.reason, code: 'denied', plugin };
    }
  }
  return undefined;
}

/**
 * Runs access.check hooks in order; the first denial wins. The returned reason is for the
 * caller's own use: it must never be sent to clients, and the kernel does not log it. `input` must be plain acyclic data; an input
 * that cannot be copied (a cycle, a throwing getter) denies with hook_error.
 */
export async function runAccessChecks(
  hooks: ReadonlyArray<{ readonly plugin: string; readonly handler: HookMap['access.check'] }>,
  input: AccessCheckInput,
  onHookError?: HookErrorHandler,
  options: AccessCheckOptions = {},
): Promise<{ readonly deny: true; readonly reason: string } | undefined> {
  const outcome = await runDenyHooks(hooks, input, onHookError, options);
  if (outcome === undefined) return undefined;
  return Object.freeze({ deny: true, reason: outcome.reason });
}
