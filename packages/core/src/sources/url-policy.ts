export type OutboundRuntime = 'node' | 'cloudflare';

export interface OutboundPolicy {
  readonly allowPrivateHosts: readonly string[];
  readonly runtime: OutboundRuntime;
  readonly selfOrigins: readonly string[];
}

export type OutboundRefusal =
  | 'invalid_url'
  | 'scheme'
  | 'userinfo'
  | 'port'
  | 'zone_id'
  | 'blocked_address'
  | 'blocked_host'
  | 'self_origin';

export type OutboundVerdict =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly reason: OutboundRefusal };

export type AddressVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: OutboundRefusal };

const refuse = (reason: OutboundRefusal): { ok: false; reason: OutboundRefusal } => ({
  ok: false,
  reason,
});

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

const IPV4_DOTTED = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;

function parseIpv4(text: string): readonly number[] | null {
  const match = IPV4_DOTTED.exec(text);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
}

function isBlockedIpv4([a, b, c]: readonly number[]): boolean {
  if (a === undefined || b === undefined || c === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function parseIpv6(text: string): readonly number[] | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const piece of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  return fill < 1 ? null : [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function embeddedIpv4(hi: number, lo: number): readonly number[] {
  return [hi >> 8, hi & 255, lo >> 8, lo & 255];
}

function isBlockedIpv6(g: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff))
    return true;
  if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xff00) === 0xff00) return true;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return true;
  if ((g0 & 0xffc0) === 0xfec0) return true;
  if (g0 === 0x3fff && g1 < 0x1000) return true;
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  if (g0 === 0x2001 && g1 === 2 && g2 === 0) return true;
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  if (g0 === 0x2001 && g1 === 0) return true;
  if (g0 === 0x2001 && g1 === 0xdb8) return true;
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIpv4(embeddedIpv4(g6, g7));
  }
  if (g0 === 0x2002) return isBlockedIpv4(embeddedIpv4(g1, g2));
  return false;
}

export function classifyAddress(ip: string): AddressVerdict {
  const text = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (text.includes('%')) return refuse('zone_id');
  if (!/^[0-9a-f:.]+$/.test(text)) return refuse('invalid_url');
  const v4 = parseIpv4(text);
  if (v4) return isBlockedIpv4(v4) ? refuse('blocked_address') : { ok: true };
  if (!text.includes(':')) return refuse('invalid_url');
  let normalized: string;
  try {
    normalized = new URL(`http://[${text}]/`).hostname.slice(1, -1);
  } catch {
    return refuse('invalid_url');
  }
  const groups = parseIpv6(normalized);
  if (!groups) return refuse('invalid_url');
  return isBlockedIpv6(groups) ? refuse('blocked_address') : { ok: true };
}

function isBlockedName(name: string): boolean {
  if (!name.includes('.')) return true;
  if (name === 'metadata.google.internal') return true;
  return BLOCKED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function cleanHost(hostname: string): string | null {
  if (hostname.startsWith('[')) return hostname;
  const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (host === '' || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null;
  return host;
}

function effectivePort(url: URL): string {
  return url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80';
}

function rawAuthority(input: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\/([^/?#\\]*)/i.exec(input)?.[1] ?? '';
}

interface SelfOrigin {
  readonly canonical: string;
  readonly key: string;
}

function normalizeSelfOrigin(raw: string): SelfOrigin {
  const input = raw.trim();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('selfOrigins entries must be absolute http(s) origins');
  }
  const host = cleanHost(url.hostname);
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    host === null ||
    rawAuthority(input).includes('@')
  ) {
    throw new Error('selfOrigins entries must be absolute http(s) origins');
  }
  return {
    canonical: `${url.protocol}//${host}${url.port === '' ? '' : `:${url.port}`}`,
    key: `${host}:${effectivePort(url)}`,
  };
}

export function parseAllowlist(
  entries: readonly string[],
  runtime: OutboundRuntime,
): readonly string[] {
  if (runtime === 'cloudflare') return [];
  return entries.map((entry) => {
    const value = entry.trim().toLowerCase();
    if (value.includes('*')) throw new Error('allowlist entries must not contain a wildcard');
    if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/.test(value)) {
      throw new Error('allowlist entries must be host or host:port');
    }
    return value;
  });
}

export function createOutboundPolicy(policy: OutboundPolicy): OutboundPolicy {
  return {
    allowPrivateHosts: parseAllowlist(policy.allowPrivateHosts, policy.runtime),
    runtime: policy.runtime,
    selfOrigins: policy.selfOrigins.map((entry) => normalizeSelfOrigin(entry).canonical),
  };
}

export function classifyUrl(input: string, policy: OutboundPolicy): OutboundVerdict {
  const text = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*\[[^\]]*%/i.test(text)) return refuse('zone_id');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return refuse('invalid_url');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return refuse('scheme');
  const hostname = cleanHost(url.hostname);
  if (hostname === null) return refuse('invalid_url');

  const selfKey = `${hostname}:${effectivePort(url)}`;
  if (policy.selfOrigins.some((self) => normalizeSelfOrigin(self).key === selfKey)) {
    return refuse('self_origin');
  }

  const allowlist = parseAllowlist(policy.allowPrivateHosts, policy.runtime);
  const allowlisted =
    allowlist.includes(`${hostname}:${effectivePort(url)}`) ||
    (url.port === '' && allowlist.includes(hostname));

  if (url.protocol === 'http:' && !allowlisted) return refuse('scheme');
  if (url.username !== '' || url.password !== '' || rawAuthority(text).includes('@')) {
    return refuse('userinfo');
  }

  const origin = `${url.protocol}//${hostname}${url.port === '' ? '' : `:${url.port}`}`;
  if (!allowlisted) {
    if (hostname.startsWith('[') || parseIpv4(hostname)) {
      if (!classifyAddress(hostname).ok) return refuse('blocked_address');
    } else if (isBlockedName(hostname)) {
      return refuse('blocked_host');
    }
    if (url.port !== '') return refuse('port');
  }
  return { ok: true, origin };
}
