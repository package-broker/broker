import { lookup as systemLookup } from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import {
  classifyAddress,
  parseAllowlist,
  type OutboundPolicy,
  type OutboundRefusal,
} from '@package-broker/core/sources/url-policy';

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface GuardedResolution {
  readonly host: string;
  readonly addresses: readonly ResolvedAddress[];
}

export type Resolver = (host: string) => Promise<readonly ResolvedAddress[]>;

export type DnsGuardReason =
  | OutboundRefusal
  | 'invalid_address'
  | 'no_address'
  | 'resolution_failed'
  | 'resolution_timeout'
  | 'aborted';

export interface DnsGuardOptions {
  readonly resolver?: Resolver;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxInFlight?: number;
}

export interface GuardedTarget {
  resolve(): Promise<GuardedResolution>;
  readonly lookup: LookupFunction;
}

export type GuardedScheme = 'http' | 'https';

export interface DnsGuard {
  forTarget(host: string, port: number, scheme?: GuardedScheme): GuardedTarget;
}

export class DnsGuardError extends Error {
  override readonly name = 'DnsGuardError';
  constructor(readonly reason: DnsGuardReason) {
    super(`outbound host refused: ${reason}`);
  }
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_IN_FLIGHT = 16;
const HTTPS_PORT = 443;

const systemResolver: Resolver = async (host) =>
  (await systemLookup(host, { all: true, verbatim: true })).map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));

function canonicalIpv6(text: string): string | null {
  if (isIP(text) !== 6 || text.includes('%')) return null;
  try {
    return new URL(`http://[${text}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function comparableHost(host: string): string {
  const bare = stripBrackets(host.toLowerCase());
  return canonicalIpv6(bare) ?? bare.replace(/\.$/, '');
}

function isAllowlisted(
  host: string,
  port: number,
  scheme: GuardedScheme | undefined,
  allowlist: readonly string[],
): boolean {
  const wanted = comparableHost(host);
  return allowlist.some((entry) => {
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(entry);
    if (!match?.[1] || comparableHost(match[1]) !== wanted) return false;
    if (match[2] !== undefined) return Number(match[2]) === port;
    return scheme !== 'http' && port === HTTPS_PORT;
  });
}

function normalizeAddress(raw: string): ResolvedAddress {
  if (raw.includes('%')) throw new DnsGuardError('zone_id');
  const kind = isIP(raw);
  if (kind === 4) return { address: raw, family: 4 };
  const canonical = kind === 6 ? canonicalIpv6(raw) : null;
  if (!canonical) throw new DnsGuardError('invalid_address');
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped?.[1] && mapped[2]) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return { address: `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, family: 4 };
  }
  return { address: canonical, family: 6 };
}

function ipv6Groups(canonical: string): number[] {
  const [head = '', tail] = canonical.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((group) => Number.parseInt(group, 16));
}

function embeddedIpv4(high: number, low: number): ResolvedAddress {
  return { address: `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, family: 4 };
}

function isNeverAllowed({ address, family }: ResolvedAddress): boolean {
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const [first = 0, second = 0] = octets;
    return first === 0 || first >= 224 || (first === 169 && second === 254);
  }
  if (address === '::' || address === 'fd00:ec2::254') return true;
  const g = ipv6Groups(address);
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if (g0 >= 0xff00 || (g0 & 0xffc0) === 0xfe80) return true;
  if (g0 === 0x2002) return isNeverAllowed(embeddedIpv4(g1, g2));
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
  const nat64 = g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
  const siit = zeroPrefix && g4 === 0xffff && g5 === 0;
  const compat = zeroPrefix && g4 === 0 && g5 === 0 && g6 !== 0;
  return (nat64 || siit || compat) && isNeverAllowed(embeddedIpv4(g6, g7));
}

function wantedFamily(family: LookupOptions['family']): 4 | 6 | undefined {
  if (family === 4 || family === 'IPv4') return 4;
  if (family === 6 || family === 'IPv6') return 6;
  return undefined;
}

function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DnsGuardError('aborted'));
      return;
    }
    const onAbort = (): void => finish(() => reject(new DnsGuardError('aborted')));
    const timer = setTimeout(
      () => finish(() => reject(new DnsGuardError('resolution_timeout'))),
      timeoutMs,
    );
    function finish(settle: () => void): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      settle();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() =>
          reject(error instanceof DnsGuardError ? error : new DnsGuardError('resolution_failed')),
        ),
    );
  });
}

export function createDnsGuard(policy: OutboundPolicy, options: DnsGuardOptions = {}): DnsGuard {
  const resolver = options.resolver ?? systemResolver;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number');
  }
  if (!Number.isInteger(maxInFlight) || maxInFlight <= 0) {
    throw new RangeError('maxInFlight must be a positive integer');
  }
  const allowlist = parseAllowlist(policy.allowPrivateHosts, policy.runtime);
  let inFlight = 0;

  function startResolution(target: string): Promise<readonly ResolvedAddress[]> {
    if (inFlight >= maxInFlight) return Promise.reject(new DnsGuardError('resolution_timeout'));
    inFlight += 1;
    const work = Promise.resolve().then(() => resolver(target));
    const release = (): void => {
      inFlight -= 1;
    };
    work.then(release, release);
    return work;
  }

  async function resolveTarget(
    host: string,
    port: number,
    scheme: GuardedScheme | undefined,
  ): Promise<GuardedResolution> {
    if (scheme === 'http' && port === HTTPS_PORT) throw new DnsGuardError('scheme');
    const literal = canonicalIpv6(stripBrackets(host.toLowerCase()));
    const target = literal ?? host;
    const resolved = await withDeadline(startResolution(target), timeoutMs, options.signal);
    if (resolved.length === 0) throw new DnsGuardError('no_address');
    const allowed = isAllowlisted(host, port, scheme, allowlist);
    const addresses = resolved.map((entry) => {
      const normalized = normalizeAddress(entry.address);
      if (isNeverAllowed(normalized)) throw new DnsGuardError('blocked_address');
      if (!allowed) {
        const verdict = classifyAddress(normalized.address);
        if (!verdict.ok) throw new DnsGuardError(verdict.reason);
      }
      return normalized;
    });
    return { host: target, addresses };
  }

  return {
    forTarget(host, port, scheme) {
      const bound = comparableHost(host);
      const lookup: LookupFunction = (requested, lookupOptions, callback) => {
        const wanted = wantedFamily(lookupOptions.family);
        const all = lookupOptions.all === true;
        const fail = (error: DnsGuardError): void => {
          process.nextTick(() => callback(error, all ? [] : '', 4));
        };
        if (comparableHost(requested) !== bound) {
          fail(new DnsGuardError('blocked_host'));
          return;
        }
        resolveTarget(host, port, scheme).then(
          ({ addresses }) => {
            const matching = addresses.filter(
              (entry) => wanted === undefined || entry.family === wanted,
            );
            const first = matching[0];
            if (!first) {
              fail(new DnsGuardError('no_address'));
              return;
            }
            process.nextTick(() => {
              if (all)
                callback(
                  null,
                  matching.map((entry): LookupAddress => ({ ...entry })),
                );
              else callback(null, first.address, first.family);
            });
          },
          (error: unknown) =>
            fail(error instanceof DnsGuardError ? error : new DnsGuardError('resolution_failed')),
        );
      };
      return { resolve: () => resolveTarget(host, port, scheme), lookup };
    },
  };
}
