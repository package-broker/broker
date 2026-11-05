function ipv4(hostname: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (match === null) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

export function isLoopback(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return ipv4(hostname)?.[0] === 127;
}

const PRIVATE_SUFFIXES = ['.internal', '.local', '.svc', '.cluster.local'];

export function isPrivateHost(hostname: string, audit = false): boolean {
  if (isLoopback(hostname) || (audit && hostname.endsWith('.localhost'))) return true;
  const octets = ipv4(hostname);
  if (octets !== null) {
    const [a, b] = octets as [number, number, number, number];
    return isPrivateIpv4([a, b]);
  }
  if (hostname.startsWith('[')) {
    const mapped = audit ? /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(hostname) : null;
    if (mapped?.[1] && mapped[2]) {
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      return isPrivateHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, true);
    }
    return /^\[(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(hostname);
  }
  return (
    hasHostSuffix(hostname, PRIVATE_SUFFIXES) ||
    (audit && (!hostname.includes('.') || hostname.endsWith('.home.arpa')))
  );
}

export function hasHostSuffix(hostname: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => hostname.endsWith(suffix));
}

export function isPrivateIpv4([a, b = -1]: readonly number[]): boolean {
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

export function isCloudMetadataHost(hostname: string): boolean {
  return (
    hostname === '169.254.169.254' ||
    hostname === '[fd00:ec2::254]' ||
    hostname === 'metadata.google.internal' ||
    hostname === 'metadata.goog' ||
    hostname === '100.100.100.200'
  );
}

/** Sink metadata and link-local destinations cannot be opted into private egress. */
export function isAuditDeniedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (isCloudMetadataHost(host)) return true;
  const octets = ipv4(host);
  if (octets !== null) return octets[0] === 169 && octets[1] === 254;
  if (!host.includes(':')) return false;
  let canonical: string;
  try {
    canonical = new URL(`http://[${host.replace(/^\[|\]$/g, '')}]/`).hostname.slice(1, -1);
  } catch {
    return true;
  }
  if (canonical === 'fd00:ec2::23' || canonical === 'fd00:ec2::254') return true;
  const [head = '', tail] = canonical.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  const g = [...left, ...fill, ...right].map((part) => Number.parseInt(part, 16));
  if (((g[0] ?? 0) & 0xffc0) === 0xfe80) return true;
  const mapped = g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0);
  const compat = g.slice(0, 6).every((n) => n === 0) && g[6] !== 0;
  const siit = g.slice(0, 4).every((n) => n === 0) && g[4] === 0xffff && g[5] === 0;
  if (mapped || nat64 || compat || siit) {
    const high = g[6] ?? 0;
    const low = g[7] ?? 0;
    return isAuditDeniedHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  if (g[0] === 0x2002) {
    const high = g[1] ?? 0;
    const low = g[2] ?? 0;
    return isAuditDeniedHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return false;
}
