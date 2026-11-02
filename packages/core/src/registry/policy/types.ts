import type { PolicyEcosystem } from '../../db/registry-policy.js';
import { isPolicyTimestamp } from '../../db/registry-policy.js';
import type { ClientHints, VersionFact } from '../../plugin.js';

export type { ClientHints, ReadKind, VersionFact } from '../../plugin.js';

export type PolicyClientHintFamily = ClientHints['family'];

export type AgeBasis = VersionFact['ageBasis'];

export type PolicyPrincipal = Readonly<{ kind: 'user' | 'service' | 'customer'; id: string }>;

/** The frozen context of one already authorized read. */
export type PolicyRequestFacts = Readonly<{
  orgId: string;
  projectId: string;
  principal: PolicyPrincipal;
  ecosystem: PolicyEcosystem;
  client: ClientHints;
  now: string;
}>;

/** Fixed reasons a version or request is refused; there is no allow verdict. */
export type PolicyDenialReason =
  | 'min_age'
  | 'blocked'
  | 'not_allowlisted'
  | 'quarantined'
  | 'client_floor'
  | 'restricted'
  | 'client_unsupported';

export type VersionDenial = Readonly<{
  versionId: string;
  revision: number;
  reason: PolicyDenialReason;
  ruleId: string | null;
  ruleRevision: number | null;
}>;

/** A decision only subtracts: the request is refused or the named candidates are. */
export type PolicyDecision =
  | Readonly<{ kind: 'deny_request'; reason: PolicyDenialReason }>
  | Readonly<{ kind: 'deny_versions'; denied: readonly VersionDenial[] }>;

const AGE_BASES: ReadonlySet<string> = new Set(['published', 'imported', 'first_seen']);
const FAMILIES: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'composer', 'unknown']);
const PRINCIPALS: ReadonlySet<string> = new Set(['user', 'service', 'customer']);
const ECOSYSTEMS: ReadonlySet<string> = new Set(['npm', 'composer']);

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new TypeError('policy fact must be a bounded string');
  }
  return value;
}

/** Copies exactly the declared fields, so extra properties such as headers never pass through. */
export function versionFact(input: VersionFact): VersionFact {
  const revision = input.revision;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError('policy fact revision must be a positive integer');
  }
  if (!isPolicyTimestamp(input.publishedAt)) {
    throw new TypeError('policy fact publishedAt must be a UTC millisecond timestamp');
  }
  if (!AGE_BASES.has(input.ageBasis)) throw new TypeError('policy fact ageBasis is unknown');
  return Object.freeze({
    packageId: text(input.packageId),
    sourceId: text(input.sourceId),
    packageKey: text(input.packageKey),
    versionId: text(input.versionId),
    version: text(input.version),
    normalizedVersion: text(input.normalizedVersion),
    revision,
    publishedAt: input.publishedAt,
    ageBasis: input.ageBasis,
  });
}

export function requestFacts(input: PolicyRequestFacts): PolicyRequestFacts {
  if (!PRINCIPALS.has(input.principal?.kind)) throw new TypeError('policy principal is unknown');
  if (!ECOSYSTEMS.has(input.ecosystem)) throw new TypeError('policy ecosystem is unknown');
  if (!FAMILIES.has(input.client?.family)) throw new TypeError('policy client family is unknown');
  const version = input.client.version;
  if (version !== null && (input.client.family === 'unknown' || !/^\d+\.\d+\.\d+$/.test(version))) {
    throw new TypeError('policy client version must be numeric');
  }
  if (!isPolicyTimestamp(input.now)) throw new TypeError('policy now must be a UTC timestamp');
  return Object.freeze({
    orgId: text(input.orgId),
    projectId: text(input.projectId),
    principal: Object.freeze({ kind: input.principal.kind, id: text(input.principal.id) }),
    ecosystem: input.ecosystem,
    client: Object.freeze({ family: input.client.family, version }),
    now: input.now,
  });
}
