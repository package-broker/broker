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
