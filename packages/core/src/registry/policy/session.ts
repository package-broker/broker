import type { ProjectActor } from '../../authz/project-actor.js';
import { PACKAGES_READ } from '../../catalogue/package-access.js';
import type { OrgContext } from '../../db/port.js';
import {
  policyPackageView,
  type PolicyEcosystem,
  type PolicySnapshot,
  type RegistryPolicyReader,
} from '../../db/registry-policy.js';
import type { Clock } from '../../ids.js';
import type { Observability } from '../../platform/observability.js';
import type { Principal, ReadKind } from '../../plugin.js';
import { evaluateMinAge } from './age.js';
import { evaluateClientFloor } from './client-floor.js';
import {
  RegistryPolicyChangedError,
  RegistryPolicyDeniedError,
  RegistryPolicyUnavailableError,
} from './errors.js';
import {
  createHookBudget,
  runRequestHooks,
  runVersionHooks,
  type HookBudget,
  type HookContext,
  type HookFailureCode,
  type RegisteredReadHook,
} from './hooks.js';
import { evaluateMembers } from './members.js';
import { createCollectionMetrics, type CollectionMetrics } from './metrics.js';
import {
  createDirectDenialAudit,
  type DirectDenialAudit,
  type PolicyEvidence,
  type PolicyReadAuditSink,
} from './read-audit.js';
import { earliest } from './rule-scope.js';
import {
  requestFacts,
  type ClientHints,
  type PolicyRequestFacts,
  type VersionFact,
} from './types.js';

export const MAX_VERSION_DECISIONS = 10_000;

/** Reads that touch many packages load every rule once instead of one snapshot per package. */
const NAMESPACE_KINDS: ReadonlySet<ReadKind> = new Set(['listing', 'search']);

export interface RegistryReadSessionDeps {
  readonly policy: RegistryPolicyReader;
  readonly hooks: readonly RegisteredReadHook[];
  readonly hookBudgetMs: number;
  readonly clock: Clock;
  readonly audit: PolicyReadAuditSink;
  readonly ids: { ulid(): string };
  readonly signal?: AbortSignal;
  readonly observability?: Pick<Observability, 'counter'>;
  readonly onHookFailure?: (event: {
    readonly plugin: string;
    readonly code: HookFailureCode;
  }) => void;
}

export interface RegistryReadSessionInput {
  /** Already authorized by the caller; the session never authorizes. */
  readonly actor: ProjectActor;
  readonly principal: Principal;
  readonly ecosystem: PolicyEcosystem;
  readonly kind: ReadKind;
  readonly client: ClientHints;
  readonly requestId: string;
  /** False for browser views, where the floor's package-manager guidance does not apply. */
  readonly clientFloor?: boolean;
}

export interface VersionVerdict {
  readonly allowed: boolean;
  readonly evidence: readonly PolicyEvidence[];
}

export interface SealOptions {
  /** Rechecks the catalogue bindings (winner, revision) the result was built from. */
  readonly bindings?: () => Promise<boolean>;
}

export interface RegistryReadSession {
  readonly actor: ProjectActor;
  readonly ecosystem: PolicyEcosystem;
  readonly kind: ReadKind;
  readonly metrics: CollectionMetrics;
  /** The evaluation instant of the current attempt. */
  now(): string;
  /** The current attempt, starting at 1; it grows with every invalidation. */
  attempt(): number;
  /** The earliest age or expiry transition among this attempt's decisions; null when none. */
  nextBoundary(): string | null;
  /** Version decisions this attempt may still make before the fixed 503. */
  remaining(): number;
  /** The normalized client family the decisions were made for. */
  readonly clientFamily: ClientHints['family'];
  /** Request-wide restrictions for one package (or none); runs once per key and attempt. */
  request(packageKey: string | null): Promise<void>;
  /** One verdict per fact, in order; memoized within the attempt. */
  evaluate(facts: readonly VersionFact[]): Promise<readonly VersionVerdict[]>;
  /** Counts a candidate hidden from a collection; no durable write. */
  hidden(fact: VersionFact, verdict: VersionVerdict): void;
  /** Durable evidence for a directly requested version that is denied; awaited before the 404. */
  denyDirect(
    readKind: 'version' | 'tag' | 'dist',
    fact: VersionFact,
    verdict: VersionVerdict,
  ): Promise<void>;
  /** Discards this attempt; the first change asks for one retry, the second is the fixed 503. */
  invalidate(): never;
  /** The final authoritative recheck before headers, a 304 or the first byte. */
  seal(options?: SealOptions): Promise<void>;
  /** Seals, cancelling the already opened body when the seal refuses. */
  sealBody(body: ReadableStream<Uint8Array> | null, options?: SealOptions): Promise<void>;
}

const ALLOWED: VersionVerdict = Object.freeze({ allowed: true, evidence: Object.freeze([]) });

function factKey(fact: VersionFact): string {
  return [
    fact.packageKey,
    fact.packageId,
    fact.sourceId,
    fact.versionId,
    String(fact.revision),
  ].join('\u0000');
}

function mayRead(actor: ProjectActor): boolean {
  return actor.kind === 'project' && actor.permissions.has(PACKAGES_READ);
}

export function createRegistryReadSession(
  deps: RegistryReadSessionDeps,
  input: RegistryReadSessionInput,
): RegistryReadSession {
  const { actor } = input;
  const ctx: OrgContext = { orgId: actor.orgId };
  const authorized = mayRead(actor);
  let budget: HookBudget;
  try {
    budget = createHookBudget({
      budgetMs: deps.hookBudgetMs,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      ...(deps.onHookFailure === undefined ? {} : { onFailure: deps.onHookFailure }),
    });
  } catch {
    throw new RegistryPolicyUnavailableError();
  }
  const metrics = createCollectionMetrics(input.ecosystem);
  const directDenialAudit = (): DirectDenialAudit =>
    createDirectDenialAudit({
      sink: deps.audit,
      ids: deps.ids,
      clock: deps.clock,
      ctx,
      requestId: input.requestId,
      projectId: actor.projectId,
      principal: { kind: input.principal.kind, id: input.principal.id },
    });

  let facts: PolicyRequestFacts;
  let attempt = 0;
  let audit: DirectDenialAudit;
  let snapshots = new Map<string | null, Promise<PolicySnapshot>>();
  let namespace: Promise<PolicySnapshot | null> | null = null;
  let requests = new Map<string | null, Promise<void>>();
  let memo = new Map<string, VersionVerdict>();
  let epoch: string | null = null;
  let boundary: string | null = null;
  let decisions = 0;
  let changes = 0;

  function begin(): void {
    try {
      facts = requestFacts({
        orgId: actor.orgId,
        projectId: actor.projectId,
        principal: { kind: input.principal.kind, id: input.principal.id },
        ecosystem: input.ecosystem,
        client: input.client,
        now: deps.clock.now().toISOString(),
      });
    } catch {
      throw new RegistryPolicyUnavailableError();
    }
    attempt += 1;
    audit = directDenialAudit();
    metrics.reset();
    snapshots = new Map();
    namespace = null;
    requests = new Map();
    memo = new Map();
    epoch = null;
    boundary = null;
    decisions = 0;
  }
  begin();

  /** Work that awaited across an invalidation belongs to a discarded attempt. */
  function current(started: number): void {
    if (started !== attempt) throw new RegistryPolicyChangedError();
  }

  const hookContext = (): HookContext => ({
    orgId: facts.orgId,
    projectId: facts.projectId,
    principal: facts.principal,
    ecosystem: facts.ecosystem,
    client: facts.client,
    now: facts.now,
  });

  function invalidate(): never {
    changes += 1;
    if (changes > 1) throw new RegistryPolicyUnavailableError();
    begin();
    throw new RegistryPolicyChangedError();
  }

  function guard(): void {
    if (!authorized) throw new RegistryPolicyUnavailableError();
  }

  async function readPackage(packageKey: string | null): Promise<PolicySnapshot> {
    try {
      return await deps.policy.snapshot(ctx, {
        ecosystem: input.ecosystem,
        projectId: actor.projectId,
        packageKey,
      });
    } catch {
      throw new RegistryPolicyUnavailableError();
    }
  }

  async function readNamespace(): Promise<PolicySnapshot | null> {
    if (deps.policy.namespace === undefined || !NAMESPACE_KINDS.has(input.kind)) return null;
    try {
      return await deps.policy.namespace(ctx, {
        ecosystem: input.ecosystem,
        projectId: actor.projectId,
      });
    } catch {
      throw new RegistryPolicyUnavailableError();
    }
  }

  /** A namespace read serves every package of the attempt; without one, each package is read. */
  async function read(packageKey: string | null): Promise<PolicySnapshot> {
    namespace ??= readNamespace();
    const all = await namespace;
    if (all === null) return readPackage(packageKey);
    try {
      return policyPackageView(all, packageKey);
    } catch {
      throw new RegistryPolicyUnavailableError();
    }
  }

  async function snapshot(packageKey: string | null): Promise<PolicySnapshot> {
    const started = attempt;
    let pending = snapshots.get(packageKey);
    if (pending === undefined) {
      pending = read(packageKey);
      snapshots.set(packageKey, pending);
    }
    const value = await pending;
    current(started);
    if (epoch === null) epoch = value.epoch;
    else if (value.epoch !== epoch) invalidate();
    return value;
  }

  async function runRequest(packageKey: string | null): Promise<void> {
    const started = attempt;
    const { rules } = await snapshot(packageKey);
    if (input.clientFloor !== false) {
      const floor = evaluateClientFloor(rules, facts.client, facts.now);
      if (floor.denials.length > 0) throw new RegistryPolicyDeniedError();
    }
    const denial = await runRequestHooks(
      deps.hooks,
      hookContext(),
      { kind: input.kind, packageKey },
      budget,
    );
    current(started);
    if (denial !== null) throw new RegistryPolicyDeniedError();
  }

  async function request(packageKey: string | null): Promise<void> {
    guard();
    let pending = requests.get(packageKey);
    if (pending === undefined) {
      pending = runRequest(packageKey);
      requests.set(packageKey, pending);
    }
    await pending;
  }

  async function evaluate(list: readonly VersionFact[]): Promise<readonly VersionVerdict[]> {
    guard();
    const started = attempt;
    const fresh = new Map<string, VersionFact>();
    for (const fact of list) {
      const key = factKey(fact);
      if (!memo.has(key)) fresh.set(key, fact);
    }
    if (fresh.size > 0) {
      if (decisions + fresh.size > MAX_VERSION_DECISIONS) {
        throw new RegistryPolicyUnavailableError();
      }
      const evidence = new Map<string, PolicyEvidence[]>();
      const survivors: VersionFact[] = [];
      let transition: string | null = null;
      for (const [key, fact] of fresh) {
        await request(fact.packageKey);
        const { rules } = await snapshot(fact.packageKey);
        const found: PolicyEvidence[] = [];
        for (const outcome of [
          evaluateMinAge(rules, fact, facts.now),
          evaluateMembers(rules, fact, facts.now),
        ]) {
          transition = earliest(transition, outcome.nextBoundary);
          for (const denial of outcome.denials) found.push({ kind: 'rule', ...denial });
        }
        evidence.set(key, found);
        if (found.length === 0) survivors.push(fact);
      }
      const hooked = await runVersionHooks(deps.hooks, hookContext(), survivors, budget);
      current(started);
      decisions += fresh.size;
      if (decisions > MAX_VERSION_DECISIONS) throw new RegistryPolicyUnavailableError();
      boundary = earliest(boundary, transition);
      if (hooked.request !== null) throw new RegistryPolicyDeniedError();
      const byId = new Map(survivors.map((fact) => [fact.versionId, factKey(fact)]));
      for (const denial of hooked.denied) {
        const key = byId.get(denial.versionId);
        if (key !== undefined)
          evidence.get(key)?.push({ kind: 'plugin', plugin: denial.plugin, reason: denial.reason });
      }
      for (const [key, found] of evidence) {
        memo.set(
          key,
          found.length === 0
            ? ALLOWED
            : Object.freeze({ allowed: false, evidence: Object.freeze(found) }),
        );
      }
    }
    return list.map((fact) => memo.get(factKey(fact)) as VersionVerdict);
  }

  async function seal(options: SealOptions = {}): Promise<void> {
    guard();
    if (boundary !== null && deps.clock.now().toISOString() >= boundary) invalidate();
    if (snapshots.size > 0) {
      const current = await readPackage(null);
      if (current.epoch !== epoch) invalidate();
    }
    if (options.bindings !== undefined) {
      let bound: boolean;
      try {
        bound = await options.bindings();
      } catch (error) {
        if (error instanceof RegistryPolicyChangedError) throw error;
        throw new RegistryPolicyUnavailableError();
      }
      if (!bound) invalidate();
    }
  }

  return {
    actor,
    ecosystem: input.ecosystem,
    kind: input.kind,
    metrics,
    now: () => facts.now,
    attempt: () => attempt,
    nextBoundary: () => boundary,
    remaining: () => MAX_VERSION_DECISIONS - decisions,
    clientFamily: input.client.family,
    request,
    evaluate,
    hidden(fact, verdict) {
      const first = verdict.evidence[0];
      if (!verdict.allowed && first !== undefined) metrics.hidden(factKey(fact), first.reason);
    },
    async denyDirect(readKind, fact, verdict) {
      guard();
      if (verdict.allowed) throw new RegistryPolicyUnavailableError();
      await audit.record({
        readKind,
        ecosystem: input.ecosystem,
        packageKey: fact.packageKey,
        versionId: fact.versionId,
        revision: fact.revision,
        evidence: verdict.evidence,
      });
    },
    invalidate,
    seal,
    async sealBody(body, options) {
      try {
        await seal(options);
      } catch (error) {
        await body?.cancel().catch(() => undefined);
        throw error;
      }
    },
  };
}

/**
 * Runs one attempt and, when the session reports a change, exactly one more; the session itself
 * turns a second change into the fixed 503. Callers with an existing two-attempt loop treat
 * RegistryPolicyChangedError like their own catalogue change instead.
 */
export async function withPolicyRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof RegistryPolicyChangedError)) throw error;
    }
  }
  throw new RegistryPolicyUnavailableError();
}
