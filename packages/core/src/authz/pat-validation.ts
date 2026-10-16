export type PatValidationMode = 'sso' | 'local' | 'service' | 'none';

export type PatValidationRefusal = 'origin_missing' | 'identity_missing' | 'inconsistent' | 'stale';

/** The part of the repository's token envelope the validation gate reads. */
export interface PatValidationView {
  readonly token: { readonly kind: 'pat' | 'svc' };
  readonly validation: {
    readonly kind: 'sso' | 'local' | null;
    readonly identityId: string | null;
    readonly fresh: boolean;
    readonly evidenceAt: string | null;
  } | null;
}

export type PatValidationDecision =
  | { readonly allowed: true; readonly mode: PatValidationMode }
  | {
      readonly allowed: false;
      readonly mode: PatValidationMode;
      readonly reason: PatValidationRefusal;
    };

export interface PatValidationReadModel {
  readonly mode: PatValidationMode;
  readonly fresh: boolean;
  readonly membershipCheckedAt: string | null;
}

/**
 * Fails closed. `fresh` is computed by the repository on database time against the origin's own
 * evidence, so this gate never compares clocks and never lets one origin stand in for the other.
 */
export function decidePatValidation(access: PatValidationView): PatValidationDecision {
  if (access.token.kind === 'svc') return { allowed: true, mode: 'service' };
  const validation = access.validation;
  if (validation === null || validation.kind === null) {
    return { allowed: false, mode: 'none', reason: 'origin_missing' };
  }
  if (validation.kind === 'sso') {
    if (validation.identityId === null) {
      return { allowed: false, mode: 'sso', reason: 'identity_missing' };
    }
  } else if (validation.identityId !== null) {
    return { allowed: false, mode: 'local', reason: 'inconsistent' };
  }
  if (validation.fresh !== true) return { allowed: false, mode: validation.kind, reason: 'stale' };
  return { allowed: true, mode: validation.kind };
}

export function describePatValidation(access: PatValidationView): PatValidationReadModel {
  const decision = decidePatValidation(access);
  return {
    mode: decision.mode,
    fresh: decision.allowed && access.token.kind === 'pat',
    membershipCheckedAt: access.validation?.evidenceAt ?? null,
  };
}
