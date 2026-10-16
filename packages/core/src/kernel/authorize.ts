import { reportHookError, runAccessChecks } from './access.js';
import type { AccessCheckOptions, HookErrorHandler } from './access.js';
import { orgContext } from '../db/port.js';
import type { OrgContext } from '../db/port.js';
import type { HookMap, Principal, RouteBoundary } from '../plugin.js';

export interface AuthorizationRequest {
  readonly request: Request;
  readonly org: OrgContext;
  readonly route: {
    readonly plugin: string;
    readonly method: string;
    readonly path: string;
    readonly permission: string;
    readonly boundary?: RouteBoundary;
  };
  readonly params: Readonly<Record<string, string>>;
}

export type AuthorizationDecision =
  | { readonly allow: true; readonly principal: Principal; readonly projectId: string | null }
  | { readonly allow: false; readonly status: 401 | 403 | 404 };

export interface AuthorizationEngine {
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}

export type DenyLogger = (entry: { readonly plugin: string; readonly reason: string }) => void;

export interface AuthorizeRouteOptions extends AccessCheckOptions {
  /** Engine deadline in ms: a safe integer in 1..600000, otherwise 2000. Expiry denies with 403. */
  readonly engineTimeoutMs?: number;
  /** Told which plugin denied and why, for logs only. */
  readonly onDeny?: DenyLogger;
}

type AccessCheckHooks = ReadonlyArray<{
  readonly plugin: string;
  readonly handler: HookMap['access.check'];
}>;

const ENGINE_PLUGIN = 'core:authorization';
/** Label for failures raised before the engine decision is used, such as input validation. */
export const INPUT_PLUGIN = 'core:authorize-input';
const DEFAULT_ENGINE_TIMEOUT_MS = 2000;
const MAX_ENGINE_TIMEOUT_MS = 600_000;
const PRINCIPAL_KINDS = {
  user: true,
  service: true,
  customer: true,
} as const satisfies Record<Principal['kind'], true>;
const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const FORBIDDEN: AuthorizationDecision = Object.freeze({ allow: false, status: 403 });
const NOT_FOUND: AuthorizationDecision = Object.freeze({ allow: false, status: 404 });
const UNAUTHORIZED: AuthorizationDecision = Object.freeze({ allow: false, status: 401 });

export class EngineTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`authorization engine did not settle within ${String(timeoutMs)} ms`);
    this.name = 'EngineTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export const denyAllEngine: AuthorizationEngine = Object.freeze({
  authorize: (): Promise<AuthorizationDecision> => Promise.resolve(FORBIDDEN),
});

function isPlainObject(value: unknown): value is object {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(target: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(target);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function dataValue(target: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined || !('value' in descriptor)) throw new TypeError(key);
  return descriptor.value as unknown;
}

function isPrincipalKind(value: unknown): value is Principal['kind'] {
  return typeof value === 'string' && Object.hasOwn(PRINCIPAL_KINDS, value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !CONTROL_CHARACTER.test(value);
}

function principalOf(value: unknown): Principal | undefined {
  if (!isPlainObject(value) || !hasExactKeys(value, ['kind', 'id'])) return undefined;
  const kind = dataValue(value, 'kind');
  const id = dataValue(value, 'id');
  if (!isPrincipalKind(kind) || !isIdentifier(id)) return undefined;
  return Object.freeze({ kind, id });
}

/**
 * Copies a well-formed decision out of the engine's value, reading each own data property once,
 * so an accessor, a proxy or a later mutation cannot change what the kernel acts on.
 */
function validDecision(value: unknown): AuthorizationDecision | undefined {
  try {
    if (!isPlainObject(value)) return undefined;
    const allow = dataValue(value, 'allow');

    if (allow === false) {
      if (!hasExactKeys(value, ['allow', 'status'])) return undefined;
      const status = dataValue(value, 'status');
      if (status === 401) return UNAUTHORIZED;
      if (status === 403) return FORBIDDEN;
      if (status === 404) return NOT_FOUND;
      return undefined;
    }

    if (allow !== true || !hasExactKeys(value, ['allow', 'principal', 'projectId']))
      return undefined;
    const principal = principalOf(dataValue(value, 'principal'));
    const projectId = dataValue(value, 'projectId');
    if (principal === undefined || (projectId !== null && !isIdentifier(projectId))) {
      return undefined;
    }
    return Object.freeze({ allow: true, principal, projectId });
  } catch {
    return undefined;
  }
}

function swallow(call: () => unknown): void {
  try {
    void Promise.resolve(call()).catch(() => undefined);
  } catch {
    return;
  }
}

function engineTimeout(options: AuthorizeRouteOptions): number {
  const value: unknown = options.engineTimeoutMs;
  return Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_ENGINE_TIMEOUT_MS
    ? (value as number)
    : DEFAULT_ENGINE_TIMEOUT_MS;
}

async function decide(
  engine: AuthorizationEngine,
  request: AuthorizationRequest,
  timeoutMs: number,
): Promise<unknown> {
  const pending = (async () => await engine.authorize(request))();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new EngineTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The engine decides first; access.check hooks run only after it allows and can only add a
 * deny, which becomes a 403. Every failure denies with 403. Hook reasons go to onDeny only and
 * never into the returned decision. A hook_error is sent to onDeny unless onHookError delivered it
 * without throwing; a missing, non-callable or throwing onHookError still reaches onDeny.
 */
export async function authorizeRoute(
  request: AuthorizationRequest,
  engine: AuthorizationEngine,
  hooks: AccessCheckHooks,
  onHookError?: HookErrorHandler,
  options: AuthorizeRouteOptions = {},
): Promise<AuthorizationDecision> {
  let org: OrgContext;
  let permission: string;
  let chain: AccessCheckHooks;
  let timeoutMs: number;
  let onDeny: DenyLogger | undefined;
  let accessOptions: AccessCheckOptions;
  try {
    org = orgContext(request.org.orgId);
    permission = request.route.permission;
    if (!isIdentifier(permission))
      throw new TypeError('route permission must be a non-empty, control-character-free string');
    chain = hooks.map(({ plugin, handler }) => ({ plugin, handler }));
    timeoutMs = engineTimeout(options);
    onDeny = options.onDeny;
    const hookTimeoutMs = options.hookTimeoutMs;
    accessOptions = Object.freeze(hookTimeoutMs === undefined ? {} : { hookTimeoutMs });
  } catch (error) {
    reportHookError(onHookError, INPUT_PLUGIN, error);
    return FORBIDDEN;
  }

  let raw: unknown;
  try {
    raw = await decide(engine, request, timeoutMs);
  } catch (error) {
    reportHookError(onHookError, ENGINE_PLUGIN, error);
    return FORBIDDEN;
  }

  const decision = validDecision(raw);
  if (decision === undefined) {
    reportHookError(onHookError, ENGINE_PLUGIN, new TypeError('malformed authorization decision'));
    return FORBIDDEN;
  }
  if (!decision.allow) return decision;

  const input = {
    org,
    principal: decision.principal,
    permission,
    projectId: decision.projectId,
  };
  for (const hook of chain) {
    let denial: { readonly reason: string } | undefined;
    let reported = false;
    const onError: HookErrorHandler | undefined =
      onHookError === undefined
        ? undefined
        : (event) => {
            const pending = onHookError(event);
            reported = true;
            return pending;
          };
    try {
      denial = await runAccessChecks([hook], input, onError, accessOptions);
    } catch {
      denial = { reason: 'hook_error' };
    }
    if (denial !== undefined) {
      const entry = Object.freeze({ plugin: hook.plugin, reason: denial.reason });
      if (onDeny !== undefined && !(denial.reason === 'hook_error' && reported))
        swallow(() => onDeny(entry));
      return FORBIDDEN;
    }
  }
  return decision;
}
