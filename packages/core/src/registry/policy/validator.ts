import { sha256Hex } from '../../auth/primitives.js';
import type { ClientHints } from './types.js';

export interface DecidedVersion {
  readonly versionId: string;
  readonly revision: number;
}

/** What a policy-filtered representation was decided from, beyond its unfiltered validator. */
export interface PolicyDecisionState {
  /** Every version that survived policy, hooks included, across the whole document. */
  readonly versions: Iterable<DecidedVersion>;
  /** The next age or expiry transition for the evaluated set; it names the current interval. */
  readonly nextBoundary: string | null;
  readonly clientFamily: ClientHints['family'];
}

/**
 * Extends an existing representation validator (form, revision, deployment, organization,
 * project, source and epoch) with the complete filtered version set, the age boundary bucket and
 * the client family. Order of discovery does not matter; the set does.
 */
export async function policyValidator(base: string, state: PolicyDecisionState): Promise<string> {
  if (typeof base !== 'string' || base === '') throw new TypeError('base validator is required');
  const members = new Set<string>();
  for (const version of state.versions) {
    if (!Number.isSafeInteger(version.revision) || version.revision < 1) {
      throw new RangeError('decided revision must be a positive integer');
    }
    members.add(`${version.versionId}\u0000${String(version.revision)}`);
  }
  return sha256Hex(
    JSON.stringify([
      'pb-policy-representation',
      1,
      base,
      [...members].sort(),
      state.nextBoundary,
      state.clientFamily,
    ]),
  );
}

/** A weak entity tag that can never equal one issued for an unfiltered representation. */
export async function policyEntityTag(base: string, state: PolicyDecisionState): Promise<string> {
  return `W/"p.${(await policyValidator(base, state)).slice(0, 32)}"`;
}
