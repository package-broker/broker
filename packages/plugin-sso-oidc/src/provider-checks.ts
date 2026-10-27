import {
  isReservedProviderId,
  isValidProviderId,
  providerFieldProblems,
} from '@package-broker/core/plugin';
import { type CloudflareAccessConfig, cloudflareAccessProblems } from './cloudflare-access.js';
import { MAX_LIST_LENGTH } from './config.js';
import { type OidcConfig, oidcProblems } from './oidc.js';
import { providerPresentation } from './presentation.js';

export type ProviderConfig = CloudflareAccessConfig | OidcConfig;
export const REJECTION_CODES = Object.freeze([
  ...(['unreadable', 'internal', 'kind', 'kind_rules'] as const),
  'duplicate_id',
  'duplicate_anchor',
  ...(['id', 'kind', 'displayName', 'trustAnchor', 'kindPrefix', 'policy'] as const).map(
    (field) => `field:${field}` as const,
  ),
] as const);
export type RejectionCode = (typeof REJECTION_CODES)[number];
export type Rejection = Readonly<{
  index: number;
  problems: readonly string[];
  codes: readonly RejectionCode[];
  id?: string;
}>;
type Fields = Record<PropertyKey, unknown>;

const UNREADABLE = 'configuration must be a readable object';
const UNRESERVED_CHARACTER = /^[A-Za-z0-9\-._~]$/;
const LIST_KEYS: readonly string[] = ['scopes', 'trustedAudiences', 'trustedEndpointOrigins'];

export function isContainer(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copyFields(raw: object): Fields {
  const copy: Fields = Object.create(null) as Fields;
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new TypeError(UNREADABLE);
    }
    Object.defineProperty(copy, key, {
      value: descriptor.value as unknown,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return copy;
}

function frozenList(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const list = value as unknown[];
  if (list.length > MAX_LIST_LENGTH) {
    throw new TypeError(UNREADABLE);
  }
  const keys = Reflect.ownKeys(list);
  if (keys.length !== list.length + 1) {
    throw new TypeError(UNREADABLE);
  }
  for (let index = 0; index < list.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(list, index);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(UNREADABLE);
    }
  }
  return Object.freeze(Array.from(list));
}

function snapshotConfig(raw: unknown): unknown {
  if (!isContainer(raw)) {
    return raw;
  }
  const copy = copyFields(raw);
  for (const key of LIST_KEYS) {
    if (Object.hasOwn(copy, key)) {
      copy[key] = frozenList(copy[key]);
    }
  }
  if (isContainer(copy['policy'])) {
    const policy = copyFields(copy['policy']);
    for (const key of ['verifiedDomains', 'emailAuthoritativeDomains']) {
      if (Object.hasOwn(policy, key)) {
        policy[key] = frozenList(policy[key]);
      }
    }
    copy['policy'] = Object.freeze(policy);
  }
  return Object.freeze(copy);
}

function problemsOf(config: unknown, codes: RejectionCode[]): string[] {
  if (!isContainer(config)) {
    codes.push('unreadable');
    return ['configuration must be an object'];
  }
  const kind = (config as { kind?: unknown }).kind;
  switch (kind) {
    case 'cloudflare-access':
    case 'oidc': {
      const problems = kind === 'oidc' ? oidcProblems(config) : cloudflareAccessProblems(config);
      if (problems.length > 0) codes.push('kind_rules');
      return problems;
    }
    default:
      codes.push('kind');
      return ['kind must be "cloudflare-access" or "oidc"'];
  }
}

export function canonicalAnchor(anchor: string): string {
  if (!anchor.startsWith('oidc:')) {
    return anchor.toLowerCase();
  }
  try {
    const url = new URL(anchor.slice('oidc:'.length));
    const path = url.pathname
      .replace(/%([0-9a-fA-F]{2})/g, (escape, hex: string) => {
        const char = String.fromCharCode(Number.parseInt(hex, 16));
        return UNRESERVED_CHARACTER.test(char) ? char : escape.toUpperCase();
      })
      .replace(/\/+$/, '');
    const host = url.hostname.replace(/\.$/, '');
    return `oidc:${url.protocol}//${host}${url.port === '' ? '' : `:${url.port}`}${path}`;
  } catch {
    return anchor;
  }
}

export function checkProviderDefinitions(list: readonly unknown[]): {
  accepted: readonly ProviderConfig[];
  rejected: readonly Rejection[];
} {
  return checkEntries(list.length, (index) => list[index]);
}

export function checkEntries(
  length: number,
  read: (index: number) => unknown,
): {
  accepted: readonly ProviderConfig[];
  rejected: readonly Rejection[];
} {
  const accepted: ProviderConfig[] = [];
  const rejected: Rejection[] = [];
  const idIndex = new Map<string, number>();
  const anchorIndex = new Map<string, number>();
  for (let index = 0; index < length; index += 1) {
    const problems: string[] = [];
    const codes: RejectionCode[] = [];
    const label = `providers[${index}]`;
    let config: unknown;
    let own: string[];
    let presentation: ReturnType<typeof providerPresentation> | undefined;
    try {
      config = snapshotConfig(read(index));
    } catch {
      rejected.push({ index, problems: [`${label}: ${UNREADABLE}`], codes: ['unreadable'] });
      continue;
    }
    const id = isContainer(config) ? (config as { id?: unknown }).id : undefined;
    const safeId = typeof id === 'string' && isValidProviderId(id) && !isReservedProviderId(id);
    if (isContainer(config) && !safeId) codes.push('field:id');
    try {
      own = problemsOf(config, codes);
      if (own.length === 0) {
        const checked = config as ProviderConfig;
        presentation = providerPresentation(checked);
        const fields = providerFieldProblems({ ...checked, ...presentation });
        own.push(...fields.problems);
        for (const field of Object.keys(fields.byField) as (keyof typeof fields.byField)[]) {
          if (fields.byField[field].length > 0) codes.push(`field:${field}`);
        }
      }
    } catch {
      own = ['internal validation failure'];
      codes.push('internal');
    }
    problems.push(...own.map((problem) => `${label}: ${problem}`));
    if (typeof id === 'string') {
      const first = idIndex.get(id);
      if (first === undefined) {
        idIndex.set(id, index);
      } else {
        problems.push(`${label}: id duplicates providers[${first}]`);
        codes.push('duplicate_id');
      }
    }
    if (own.length === 0 && presentation !== undefined) {
      const key = canonicalAnchor(presentation.trustAnchor);
      const first = anchorIndex.get(key);
      if (first === undefined) {
        anchorIndex.set(key, index);
      } else {
        problems.push(`${label}: trust anchor duplicates providers[${first}]`);
        codes.push('duplicate_anchor');
      }
    }
    if (problems.length > 0) {
      const identity = safeId ? { id } : {};
      rejected.push({ index, problems, codes: [...new Set(codes)].sort(), ...identity });
    } else {
      accepted.push(config as ProviderConfig);
    }
  }
  for (const entry of rejected) {
    Object.freeze(entry.problems);
    Object.freeze(entry.codes);
    Object.freeze(entry);
  }
  return { accepted: Object.freeze(accepted), rejected: Object.freeze(rejected) };
}
