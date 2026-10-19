import { looksLikeCredential } from '../platform/credential.js';

export interface TokenLifetimeInput {
  readonly maxLifetimeDays?: {
    readonly personal?: number;
    readonly service?: number;
  };
}

export interface TokenLifetimePolicy {
  readonly personal: { readonly maxDays: number };
  readonly service: { readonly maxDays: number };
}

export const TOKEN_LIFETIME_DEFAULT_MAX_DAYS = 365;
export const PERSONAL_TOKEN_LIFETIME_CEILING_DAYS = 365;
export const SERVICE_TOKEN_LIFETIME_CEILING_DAYS = 3650;

export class TokenConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid token config: ${problems.join('; ')}`);
    this.name = 'TokenConfigError';
    this.problems = problems;
  }
}

const DAY_MS = 86_400_000;
const MAXIMUM_MARGIN_MS = 60_000;
const RANGES = 'personal 1..365; service 1..3650';

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function keyPath(key: string): string {
  return key.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(key) && !looksLikeCredential(key)
    ? key
    : '<redacted>';
}

export function resolveTokenLifetimePolicy(
  input: TokenLifetimeInput | undefined,
): TokenLifetimePolicy {
  const problems: string[] = [];
  let personal = TOKEN_LIFETIME_DEFAULT_MAX_DAYS;
  let service = TOKEN_LIFETIME_DEFAULT_MAX_DAYS;
  const value: unknown = input;
  if (value !== undefined) {
    if (!isObject(value)) {
      problems.push(`tokens: must be an object (${RANGES})`);
    } else {
      for (const key of Object.keys(value)) {
        if (key !== 'maxLifetimeDays') {
          problems.push(`tokens.${keyPath(key)}: unknown key (${RANGES})`);
        }
      }
      const maxima = Object.hasOwn(value, 'maxLifetimeDays') ? value.maxLifetimeDays : undefined;
      if (maxima !== undefined) {
        if (!isObject(maxima)) {
          problems.push(`tokens.maxLifetimeDays: must be an object (${RANGES})`);
        } else {
          for (const key of Object.keys(maxima)) {
            if (key !== 'personal' && key !== 'service') {
              problems.push(`tokens.maxLifetimeDays.${keyPath(key)}: unknown key (${RANGES})`);
              continue;
            }
            const days = maxima[key];
            const ceiling =
              key === 'personal'
                ? PERSONAL_TOKEN_LIFETIME_CEILING_DAYS
                : SERVICE_TOKEN_LIFETIME_CEILING_DAYS;
            if (
              typeof days !== 'number' ||
              !Number.isSafeInteger(days) ||
              days < 1 ||
              days > ceiling
            ) {
              problems.push(
                `tokens.maxLifetimeDays.${key}: must be a safe integer in 1..${ceiling}`,
              );
            } else if (key === 'personal') {
              personal = days;
            } else {
              service = days;
            }
          }
        }
      }
    }
  }
  if (problems.length > 0) throw new TokenConfigError(problems);
  return Object.freeze({
    personal: Object.freeze({ maxDays: personal }),
    service: Object.freeze({ maxDays: service }),
  });
}

export function defaultExpiry(
  nowMs: number,
  maxDays: number,
  organizationDefaultDays: number,
): number | null {
  if (!Number.isSafeInteger(organizationDefaultDays) || organizationDefaultDays <= 0) return null;
  return (
    nowMs +
    Math.min(organizationDefaultDays, maxDays) * DAY_MS -
    (organizationDefaultDays >= maxDays ? MAXIMUM_MARGIN_MS : 0)
  );
}

export function lifetimeExpiry(
  nowMs: number,
  maxDays: number,
  lifetimeDays: number,
): number | null {
  if (!Number.isSafeInteger(lifetimeDays) || lifetimeDays < 1 || lifetimeDays > maxDays)
    return null;
  return nowMs + lifetimeDays * DAY_MS - (lifetimeDays === maxDays ? MAXIMUM_MARGIN_MS : 0);
}
