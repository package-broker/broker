import { DbError } from '../db/errors.js';
import type { SqlExecutor, Statement, StatementResult } from '../db/port.js';
import type { JobGuard } from '../platform/job-repository.js';
import { PERMISSIONS } from './permissions.js';

declare const MUTATION_FENCE: unique symbol;
declare const SYSTEM_MUTATION_FENCE: unique symbol;
declare const TOKEN_MUTATION_FENCE: unique symbol;
declare const DELEGATED_MUTATION_FENCE: unique symbol;
declare const AUTHENTICATED_ACTOR: unique symbol;
declare const AUTHENTICATED_TOKEN_ACTOR: unique symbol;
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

/** The API token the server verified for this request; never built from a request body. */
export interface AuthenticatedTokenActor {
  readonly [AUTHENTICATED_TOKEN_ACTOR]: true;
  readonly tokenId: string;
  readonly tokenKind: 'pat' | 'svc';
  readonly principalId: string;
}

const SYSTEM_WRITER_NAMES = [
  'ingest-finalize',
  'purge',
  'audit-seal',
  'audit-verify',
  'verifier',
] as const;

export type SystemWriter = (typeof SYSTEM_WRITER_NAMES)[number];

/** A write by a server job; the db guard re-checks that this exact lease is still held. */
export interface SystemMutationFence {
  readonly [SYSTEM_MUTATION_FENCE]: true;
  readonly writer: SystemWriter;
  readonly job: Readonly<JobGuard>;
  readonly expected: Readonly<Record<string, number>>;
}

/** A write by an API token; the db guard re-checks the token, its principal and the permission. */
export interface TokenMutationFence {
  readonly [TOKEN_MUTATION_FENCE]: true;
  readonly tokenId: string;
  readonly tokenKind: 'pat' | 'svc';
  readonly principalId: string;
  readonly permission: string;
  readonly expected: Readonly<Record<string, number>>;
}

/** An import apply run by a job on behalf of the user who approved the run. */
export interface DelegatedMutationFence {
  readonly [DELEGATED_MUTATION_FENCE]: true;
  readonly approverUserId: string;
  readonly runId: string;
  readonly job: Readonly<JobGuard>;
  readonly expected: Readonly<Record<string, number>>;
}

export type AnyMutationFence =
  MutationFence | SystemMutationFence | TokenMutationFence | DelegatedMutationFence;

interface FenceByKind {
  readonly session: MutationFence;
  readonly system: SystemMutationFence;
  readonly token: TokenMutationFence;
  readonly delegated: DelegatedMutationFence;
}

export type FenceKind = keyof FenceByKind;

type FenceFields<K extends FenceKind> = Omit<
  FenceByKind[K],
  | typeof MUTATION_FENCE
  | typeof SYSTEM_MUTATION_FENCE
  | typeof TOKEN_MUTATION_FENCE
  | typeof DELEGATED_MUTATION_FENCE
>;

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
const issued = new WeakMap<object, FenceKind>();
const SYSTEM_WRITERS: ReadonlySet<string> = new Set(SYSTEM_WRITER_NAMES);
const TOKEN_PERMISSIONS: ReadonlySet<string> = new Set(
  PERMISSIONS.filter((info) => !info.sessionOnly && !info.name.endsWith(':read')).map(
    (info) => info.name,
  ),
);
const CONSTRAINT_KINDS: ReadonlySet<string> = new Set([
  'unique',
  'foreign_key',
  'not_null',
  'check',
]);

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`fence ${field} must be a non-empty string`);
  }
  return value;
}

function revisionsOf(expected: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const revisions: Record<string, number> = {};
  for (const [key, revision] of Object.entries(expected)) {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new TypeError(`fence expected revision for ${key} must be a safe integer >= 1`);
    }
    revisions[key] = revision;
  }
  return Object.freeze(revisions);
}

function leaseOf(job: JobGuard): Readonly<JobGuard> {
  const id = requireText(job.id, 'job id');
  const owner = requireText(job.owner, 'job owner');
  if (!Number.isSafeInteger(job.fence) || job.fence < 1) {
    throw new TypeError('fence job fence must be a safe integer >= 1');
  }
  return Object.freeze({ id, owner, fence: job.fence });
}

function issue<K extends FenceKind>(kind: K, fields: FenceFields<K>): FenceByKind[K] {
  const fence = Object.freeze(fields);
  issued.set(fence, kind);
  return fence as unknown as FenceByKind[K];
}

export function mutationFence(
  actor: AuthenticatedActor,
  expected: Readonly<Record<string, number>>,
): MutationFence {
  const userId = requireText(actor.userId, 'userId');
  const sessionId = requireText(actor.sessionId, 'sessionId');
  return issue('session', { userId, sessionId, expected: revisionsOf(expected) });
}

export function systemMutationFence(
  writer: SystemWriter,
  job: JobGuard,
  expected: Readonly<Record<string, number>>,
): SystemMutationFence {
  if (!SYSTEM_WRITERS.has(writer)) {
    throw new TypeError(`fence writer ${JSON.stringify(writer)} is not a system writer`);
  }
  return issue('system', {
    writer,
    job: leaseOf(job),
    expected: revisionsOf(expected),
  });
}

/** Only non-session-only write permissions; session-only writes stay unreachable from a token. */
export function tokenMutationFence(
  actor: AuthenticatedTokenActor,
  permission: string,
  expected: Readonly<Record<string, number>>,
): TokenMutationFence {
  const tokenId = requireText(actor.tokenId, 'tokenId');
  const principalId = requireText(actor.principalId, 'principalId');
  if (actor.tokenKind !== 'pat' && actor.tokenKind !== 'svc') {
    throw new TypeError('fence tokenKind must be pat or svc');
  }
  if (!TOKEN_PERMISSIONS.has(permission)) {
    throw new TypeError(`fence permission ${JSON.stringify(permission)} is not usable by a token`);
  }
  return issue('token', {
    tokenId,
    tokenKind: actor.tokenKind,
    principalId,
    permission,
    expected: revisionsOf(expected),
  });
}

export function delegatedMutationFence(
  approverUserId: string,
  runId: string,
  job: JobGuard,
  expected: Readonly<Record<string, number>>,
): DelegatedMutationFence {
  return issue('delegated', {
    approverUserId: requireText(approverUserId, 'approverUserId'),
    runId: requireText(runId, 'runId'),
    job: leaseOf(job),
    expected: revisionsOf(expected),
  });
}

export function fenceKind(fence: AnyMutationFence): FenceKind {
  const kind = typeof fence === 'object' && fence !== null ? issued.get(fence) : undefined;
  if (kind === undefined) {
    throw new TypeError('fenceKind requires a fence from a fence constructor');
  }
  return kind;
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
  fence: AnyMutationFence,
  guard: FenceGuard,
  mutations: readonly Statement[],
  probes: FailureProbes,
): Promise<FencedOutcome> {
  if (typeof fence !== 'object' || fence === null || !issued.has(fence)) {
    throw new TypeError('runFenced requires a fence from a fence constructor');
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
