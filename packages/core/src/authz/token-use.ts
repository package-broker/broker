import { dummyVerify, verifyToken } from '../secrets/token-hash.js';
import type { Keyring } from '../secrets/keyring.js';
import { parseToken } from '../secrets/token-format.js';

export const TOUCH_WINDOW_MS = 300_000;

export type TokenUseDiagnostic =
  'malformed' | 'reserved' | 'invalid' | 'revoked' | 'expired' | 'principal_inactive' | 'denied';

/** The part of the repository's token envelope this gate reads. */
export interface TokenAccessView {
  /** Whether the principal can see the project independently of token scope or binding. */
  readonly projectVisible: boolean;
  readonly token: {
    readonly id: string;
    readonly kind: 'pat' | 'svc';
    readonly expired: boolean;
    readonly revoked: boolean;
    readonly lastUsedAt: string | null;
  };
  readonly principalStatus: string;
  readonly verifier: { readonly secretHash: string; readonly pepperVersion: number };
}

export type TokenUseResult<A extends TokenAccessView> =
  | { readonly ok: true; readonly access: A }
  | {
      readonly ok: false;
      readonly reason: 'unauthorized';
      readonly diagnostic: TokenUseDiagnostic;
    };

export interface TokenUseDeps {
  readonly keyring: Keyring;
  readonly nowMs: () => number;
  /** Conditional last_used_at update on database time; true when a row changed. */
  readonly touch: (tokenId: string, kind: 'pat' | 'svc') => Promise<boolean>;
  /**
   * Schedules the touch without awaiting it. Workers: `(run) => ctx.waitUntil(run())`. Node:
   * `deferredDispatch`, because a synchronous driver would otherwise run the SQL on the request path.
   */
  readonly dispatch: (run: () => Promise<void>) => void;
  readonly log: (event: 'token_touch_failed') => void;
}

function refused<A extends TokenAccessView>(diagnostic: TokenUseDiagnostic): TokenUseResult<A> {
  return { ok: false, reason: 'unauthorized', diagnostic };
}

function safeLog(deps: TokenUseDeps): void {
  try {
    deps.log('token_touch_failed');
  } catch {
    return;
  }
}

function stale(deps: TokenUseDeps, lastUsedAt: string | null): boolean {
  if (lastUsedAt === null) return true;
  try {
    const age = deps.nowMs() - Date.parse(lastUsedAt);
    return !Number.isFinite(age) || age >= TOUCH_WINDOW_MS;
  } catch {
    return true;
  }
}

async function runTouch(deps: TokenUseDeps, tokenId: string, kind: 'pat' | 'svc'): Promise<void> {
  try {
    await deps.touch(tokenId, kind);
  } catch {
    safeLog(deps);
  }
}

export function deferredDispatch(run: () => Promise<void>): void {
  setTimeout(() => {
    try {
      run().catch(() => undefined);
    } catch {
      return;
    }
  }, 0);
}

function dispatchTouch(deps: TokenUseDeps, tokenId: string, kind: 'pat' | 'svc'): void {
  try {
    deps.dispatch(() => runTouch(deps, tokenId, kind));
  } catch {
    safeLog(deps);
  }
}

export async function authenticateToken<A extends TokenAccessView>(
  deps: TokenUseDeps,
  presented: unknown,
  lookup: (selector: string) => Promise<A | null>,
  decide: (access: A) => boolean | Promise<boolean>,
): Promise<TokenUseResult<A>> {
  const parsed = parseToken(presented);
  if (!parsed.ok) return refused('malformed');
  if (parsed.reserved) return refused('reserved');
  const access = await lookup(parsed.selector);
  const proven =
    access === null
      ? await dummyVerify(parsed.canonical)
      : await verifyToken(
          deps.keyring,
          access.verifier.pepperVersion,
          parsed.canonical,
          access.verifier.secretHash,
        );
  if (access === null || !proven || access.token.kind !== parsed.kind) return refused('invalid');
  if (access.token.revoked) return refused('revoked');
  if (access.token.expired) return refused('expired');
  if (access.principalStatus !== 'active') return refused('principal_inactive');
  if ((await decide(access)) !== true) return refused('denied');
  if (stale(deps, access.token.lastUsedAt)) dispatchTouch(deps, access.token.id, access.token.kind);
  return { ok: true, access };
}
