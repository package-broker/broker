import { domainPolicyProblems } from './policy.js';
import {
  isReservedProviderId,
  isValidProviderId,
  isValidTrustAnchor,
  type DomainPolicy,
} from './port.js';

const UNSAFE_DISPLAY_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_DOMAINS = 100;
const PROVIDER_KINDS: readonly string[] = ['cloudflare-access', 'oidc'];

export function readLength(list: readonly unknown[]): number | null {
  const length: unknown = list.length;
  return typeof length === 'number' && Number.isSafeInteger(length) && length >= 0 ? length : null;
}

export function copyIndexed(list: readonly unknown[], length: number): unknown[] {
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
    let value: unknown;
    if (descriptor !== undefined) {
      value =
        'value' in descriptor
          ? descriptor.value
          : descriptor.get === undefined
            ? undefined
            : Reflect.apply(descriptor.get, list, []);
    }
    Object.defineProperty(items, index, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return items;
}

function snapshotPolicy(raw: unknown): {
  readonly policy: DomainPolicy | null;
  readonly problems: string[];
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { policy: null, problems: domainPolicyProblems(raw as DomainPolicy) };
  }
  const source = raw as {
    verifiedDomains?: unknown;
    emailAuthoritativeDomains?: unknown;
    autoJoin?: unknown;
  };
  const snapshot: Record<string, unknown> = {};
  for (const key of ['verifiedDomains', 'emailAuthoritativeDomains'] as const) {
    const domains = source[key];
    if (Array.isArray(domains)) {
      const length = readLength(domains as unknown[]);
      if (length === null || length > MAX_DOMAINS) {
        return {
          policy: null,
          problems: [`${key} must be an array of at most ${MAX_DOMAINS} entries`],
        };
      }
      snapshot[key] = copyIndexed(domains as unknown[], length);
    } else {
      snapshot[key] = domains;
    }
  }
  const policy = { ...snapshot, autoJoin: source.autoJoin } as unknown as DomainPolicy;
  const problems = domainPolicyProblems(policy);
  return { policy: problems.length === 0 ? policy : null, problems };
}

export function providerFieldProblems(fields: {
  id: unknown;
  kind: unknown;
  displayName: unknown;
  trustAnchor: unknown;
  policy: unknown;
}): {
  /** Valid policy snapshot, or empty deny-all policy when policy validation fails. */
  policy: DomainPolicy;
  problems: string[];
  byField: Record<
    'id' | 'kind' | 'trustAnchor' | 'displayName' | 'kindPrefix' | 'policy',
    string[]
  >;
} {
  const { id, kind, displayName, trustAnchor } = fields;
  const { policy, problems: policyProblems } = snapshotPolicy(fields.policy);
  const byField = {
    id: [] as string[],
    kind: [] as string[],
    trustAnchor: [] as string[],
    displayName: [] as string[],
    kindPrefix: [] as string[],
    policy: [] as string[],
  };
  if (typeof id !== 'string' || !isValidProviderId(id)) {
    byField.id.push(`id is not a valid provider id (type ${typeof id})`);
  } else if (isReservedProviderId(id)) {
    byField.id.push(`id ${JSON.stringify(id)} is reserved`);
  }
  if (typeof kind !== 'string' || !PROVIDER_KINDS.includes(kind)) {
    byField.kind.push(`kind must be "cloudflare-access" or "oidc"`);
  }
  if (typeof trustAnchor !== 'string' || !isValidTrustAnchor(trustAnchor)) {
    byField.trustAnchor.push(`trustAnchor is not a valid trust anchor`);
  }
  if (
    typeof displayName !== 'string' ||
    displayName.length < 1 ||
    displayName.length > MAX_DISPLAY_NAME_LENGTH ||
    UNSAFE_DISPLAY_CHARACTER.test(displayName)
  ) {
    byField.displayName.push(
      `displayName must be 1 to ${MAX_DISPLAY_NAME_LENGTH} characters without control or format characters`,
    );
  }
  if (
    typeof kind === 'string' &&
    PROVIDER_KINDS.includes(kind) &&
    typeof trustAnchor === 'string' &&
    isValidTrustAnchor(trustAnchor) &&
    !trustAnchor.startsWith(kind === 'oidc' ? 'oidc:' : 'access:')
  ) {
    byField.kindPrefix.push(`kind does not match the trustAnchor prefix`);
  }
  for (const problem of policyProblems) {
    byField.policy.push(`policy: ${problem}`);
  }
  return {
    policy: policy ?? { verifiedDomains: [], emailAuthoritativeDomains: [], autoJoin: false },
    problems: Object.values(byField).flat(),
    byField,
  };
}
