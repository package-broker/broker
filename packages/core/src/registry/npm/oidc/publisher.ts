import { packageKey } from '../../../catalogue/names.js';
import type { OidcRepository, TrustedPublisherBinding } from '../../../db/oidc.js';
import type { OrgContext } from '../../../db/port.js';
import { invalid, OidcError } from './input.js';
import type { VerifiedOidcClaims } from './verify.js';

export function matchesRef(pattern: string | null, ref: string): boolean {
  if (
    ref.length > 1024 ||
    (pattern !== null &&
      (pattern.length < 1 || pattern.length > 255 || !/^[A-Za-z0-9._/@:+?*-]+$/.test(pattern)))
  )
    throw new OidcError('no_trusted_publisher');
  if (pattern === null) return true;
  let previous = new Uint8Array(ref.length + 1);
  previous[0] = 1;
  for (const ch of pattern) {
    const next = new Uint8Array(ref.length + 1);
    if (ch === '*') next[0] = previous[0]!;
    for (let i = 1; i <= ref.length; i++)
      next[i] =
        ch === '*'
          ? previous[i]! | next[i - 1]!
          : ch === '?' || ch === ref[i - 1]
            ? previous[i - 1]!
            : 0;
    previous = next;
  }
  return previous[ref.length] === 1;
}

export async function findTrustedPublisher(
  repository: Pick<OidcRepository, 'find'>,
  ctx: OrgContext,
  packageName: string,
  claims: VerifiedOidcClaims,
): Promise<TrustedPublisherBinding> {
  try {
    packageKey(packageName, { ecosystem: 'npm' });
  } catch {
    invalid();
  }
  const rows = await repository.find(ctx, {
    packageName,
    repositoryId: claims.repositoryId,
    repositoryOwnerId: claims.repositoryOwnerId,
    workflow: claims.workflow,
    environment: claims.environment,
  });
  if (rows.length > 1) throw new OidcError('ambiguous_trusted_publisher');
  const row = rows[0];
  if (!row || !matchesRef(row.refPattern, claims.ref)) throw new OidcError('no_trusted_publisher');
  return row;
}
