import { isPolicyClientVersion, type PolicyEcosystem } from '../../db/registry-policy.js';
import type { ClientHints, PolicyClientHintFamily } from './types.js';

export const MAX_CLIENT_HINT_BYTES = 512;

const UNKNOWN: ClientHints = Object.freeze({ family: 'unknown', version: null });
const FAMILIES: ReadonlyMap<string, Exclude<PolicyClientHintFamily, 'unknown'>> = new Map([
  ['npm', 'npm'],
  ['pnpm', 'pnpm'],
  ['yarn', 'yarn'],
  ['composer', 'composer'],
]);
const ECOSYSTEM_FAMILIES: Readonly<Record<PolicyEcosystem, ReadonlySet<string>>> = {
  npm: new Set(['npm', 'pnpm', 'yarn']),
  composer: new Set(['composer']),
};
const TOKEN = /^([A-Za-z]+)\/(\S*)$/;
const PRINTABLE = /^[\x20-\x7e]*$/;
const encoder = new TextEncoder();

/**
 * Reduces a User-Agent value to a recognized family and a stable numeric version. The family is
 * the leading product token; any other family token with a numeric version makes the claim
 * ambiguous. The raw value is never retained. Hints are spoofable compatibility signals.
 */
export function normalizeClientHints(raw: unknown, ecosystem: PolicyEcosystem): ClientHints {
  if (typeof raw !== 'string') return UNKNOWN;
  if (raw.length > MAX_CLIENT_HINT_BYTES || encoder.encode(raw).length > MAX_CLIENT_HINT_BYTES) {
    return UNKNOWN;
  }
  if (!PRINTABLE.test(raw)) return UNKNOWN;
  const tokens = raw.trim().split(/\s+/);
  const lead = TOKEN.exec(tokens[0] ?? '');
  if (lead === null) return UNKNOWN;
  const family = FAMILIES.get(lead[1]!.toLowerCase());
  const version = lead[2]!;
  if (family === undefined || !isPolicyClientVersion(version)) return UNKNOWN;
  for (const token of tokens.slice(1)) {
    const other = TOKEN.exec(token);
    if (other === null) continue;
    if (FAMILIES.has(other[1]!.toLowerCase()) && /^\d/.test(other[2]!)) return UNKNOWN;
  }
  if (!ECOSYSTEM_FAMILIES[ecosystem].has(family)) return UNKNOWN;
  return Object.freeze({ family, version });
}
