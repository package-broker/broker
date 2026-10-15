import { DbError } from '../db/errors.js';
import type { SqlExecutor, Statement, StatementResult } from '../db/port.js';

declare const MUTATION_FENCE: unique symbol;
declare const AUTHENTICATED_ACTOR: unique symbol;
declare const FENCE_GUARD: unique symbol;

/** The actor and session the server authenticated for this request; never built from a request body. */
export interface AuthenticatedActor {
  readonly [AUTHENTICATED_ACTOR]: true;
  readonly userId: string;
  readonly sessionId: string;
}

export interface MutationFence {
  readonly [MUTATION_FENCE]: true;
  readonly userId: string;
  readonly sessionId: string;
  readonly expected: Readonly<Record<string, number>>;
}

/** Already-compiled guard statements produced by the db layer; core never builds SQL. */
export type FenceGuard = readonly Statement[] & { readonly [FENCE_GUARD]: true };

export type FailureReason = 'authority' | 'conflict' | 'collision' | 'unclassified';

/** Each probe is a read returning a row whose first column is non-zero when that cause currently holds. */
export interface FailureProbes {
  readonly authority?: Statement;
  readonly conflict?: Statement;
  readonly collision?: Statement;
}

export type FencedOutcome =
  | { readonly ok: true; readonly results: StatementResult[] }
  | { readonly ok: false; readonly reason: FailureReason | 'indeterminate' };

const MAX_GUARD_STATEMENTS = 4;
const issued = new WeakSet<object>();
const CONSTRAINT_KINDS: ReadonlySet<string> = new Set([
  'unique',
  'foreign_key',
  'not_null',
  'check',
]);

export function mutationFence(
  actor: AuthenticatedActor,
  expected: Readonly<Record<string, number>>,
): MutationFence {
  if (typeof actor.userId !== 'string' || actor.userId === '') {
    throw new TypeError('fence userId must be a non-empty string');
  }
  if (typeof actor.sessionId !== 'string' || actor.sessionId === '') {
    throw new TypeError('fence sessionId must be a non-empty string');
  }
  const revisions: Record<string, number> = {};
  for (const [key, revision] of Object.entries(expected)) {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new TypeError(`fence expected revision for ${key} must be a safe integer >= 1`);
    }
    revisions[key] = revision;
  }
  const fence = Object.freeze({
    userId: actor.userId,
    sessionId: actor.sessionId,
    expected: Object.freeze(revisions),
  }) as unknown as MutationFence;
  issued.add(fence);
  return fence;
}

/** Db layer only (packages/db-sqlite); the architecture test rejects any other importer. */
export function fenceGuard(statements: readonly Statement[]): FenceGuard {
  return Object.freeze([...statements]) as unknown as FenceGuard;
}

async function probeHolds(executor: SqlExecutor, probe: Statement | undefined): Promise<boolean> {
  if (probe === undefined) return false;
  const first = (await executor.all<Record<string, unknown>>(probe))[0];
  if (first === undefined) return false;
  const value = Object.values(first)[0];
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  return false;
}

/** Non-authoritative read after a failed batch; checks authority, then conflict, then collision. */
export async function classifyFailure(
  executor: SqlExecutor,
  probes: FailureProbes,
): Promise<FailureReason> {
  try {
    if (await probeHolds(executor, probes.authority)) return 'authority';
    if (await probeHolds(executor, probes.conflict)) return 'conflict';
    if (await probeHolds(executor, probes.collision)) return 'collision';
  } catch {
    return 'unclassified';
  }
  return 'unclassified';
}

/**
 * Runs guard then mutations as one executor batch. A lost response may have committed, so it is
 * indeterminate; probes run only after constraint failures; anything else is rethrown.
 */
export async function runFenced(
  executor: SqlExecutor,
  fence: MutationFence,
  guard: FenceGuard,
  mutations: readonly Statement[],
  probes: FailureProbes,
): Promise<FencedOutcome> {
  if (typeof fence !== 'object' || fence === null || !issued.has(fence)) {
    throw new TypeError('runFenced requires a MutationFence from mutationFence()');
  }
  if (!Array.isArray(guard) || guard.length === 0 || guard.length > MAX_GUARD_STATEMENTS) {
    throw new TypeError(`runFenced requires a guard of 1 to ${MAX_GUARD_STATEMENTS} statements`);
  }
  try {
    return { ok: true, results: await executor.batch([...guard, ...mutations]) };
  } catch (error) {
    if (!(error instanceof DbError)) throw error;
    if (error.kind === 'unknown') return { ok: false, reason: 'indeterminate' };
    if (!CONSTRAINT_KINDS.has(error.kind)) return { ok: false, reason: 'unclassified' };
    return { ok: false, reason: await classifyFailure(executor, probes) };
  }
}
