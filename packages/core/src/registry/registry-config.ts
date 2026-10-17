import type { Platform } from '../plugin.js';
import { containsCredentialToken, looksLikeCredential } from '../platform/credential.js';

export const MAX_METADATA_BYTES = 32 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export interface RegistryConfigInput {
  readonly outbound?:
    | {
        readonly allowPrivateHosts?: readonly string[] | undefined;
        readonly extraSelfOrigins?: readonly string[] | undefined;
      }
    | undefined;
  readonly userAgent?:
    | { readonly default?: string | undefined; readonly composerStyle?: string | undefined }
    | undefined;
  readonly upstreamContact?: string | undefined;
  readonly timers?:
    | {
        readonly metadataTtlSeconds?: number | undefined;
        readonly negativeTtlSeconds?: number | undefined;
        readonly waitBudgetMs?: number | undefined;
      }
    | undefined;
  readonly caps?:
    | { readonly metadataBytes?: number | undefined; readonly archiveBytes?: number | undefined }
    | undefined;
}

export interface RegistryConfig {
  readonly outbound: {
    readonly allowPrivateHosts: readonly string[];
    readonly selfOrigins: readonly string[];
  };
  readonly userAgent: { readonly default: string; readonly composerStyle: string };
  readonly upstreamContact: string;
  readonly timers: {
    readonly metadataTtlSeconds: number;
    readonly negativeTtlSeconds: number;
    readonly waitBudgetMs: number;
  };
  readonly caps: { readonly metadataBytes: number; readonly archiveBytes: number };
}

export type RegistryDefaults = Omit<RegistryConfig, 'outbound'>;

export const REGISTRY_DEFAULTS: RegistryDefaults = Object.freeze({
  userAgent: Object.freeze({ default: 'PackageBroker/2', composerStyle: 'Composer/2.8.0' }),
  upstreamContact: 'https://github.com/package-broker/broker',
  timers: Object.freeze({ metadataTtlSeconds: 300, negativeTtlSeconds: 30, waitBudgetMs: 8000 }),
  caps: Object.freeze({ metadataBytes: MAX_METADATA_BYTES, archiveBytes: MAX_ARCHIVE_BYTES }),
});

export class RegistryConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid registry config: ${problems.join('; ')}`);
    this.name = 'RegistryConfigError';
    this.problems = problems;
  }
}

const PLATFORMS: readonly Platform[] = ['cloudflare', 'node'];
const ROOT_KEYS = ['outbound', 'userAgent', 'upstreamContact', 'timers', 'caps'];
const SECTION_KEYS = {
  outbound: ['allowPrivateHosts', 'extraSelfOrigins'],
  userAgent: ['default', 'composerStyle'],
  timers: ['metadataTtlSeconds', 'negativeTtlSeconds', 'waitBudgetMs'],
  caps: ['metadataBytes', 'archiveBytes'],
} as const;
const MAX_STRING_LENGTH = 200;
const MAX_KEY_LENGTH = 64;
const SAFE_KEY = /^[A-Za-z0-9_.-]+$/;
const MAX_EXTRA_SELF_ORIGINS = 16;
const TIMER_LIMITS = {
  metadataTtlSeconds: 86400,
  negativeTtlSeconds: 86400,
  waitBudgetMs: 25000,
} as const;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const PORT = /^[1-9][0-9]{0,4}$/;
const MAILTO = /^mailto:[^\s@?#,]+@[^\s@?#,]+\.[^\s@?#,]+$/;

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(object: Obj, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function agentLooksLikeCredential(value: string): boolean {
  return (
    containsCredentialToken(value) ||
    value
      .split(/[\s/;,()]+/)
      .filter(Boolean)
      .some(looksLikeCredential)
  );
}

function safeKey(key: string): string {
  if (key.length > MAX_KEY_LENGTH || !SAFE_KEY.test(key) || looksLikeCredential(key)) {
    return '<redacted>';
  }
  return key;
}
function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function stripDots(host: string): string {
  return host.replace(/\.+$/, '');
}

function validHostname(hostname: string): boolean {
  if (hostname.startsWith('[')) return true;
  const name = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  return name
    .split('.')
    .every((label) => label !== '' && !label.startsWith('-') && !label.endsWith('-'));
}

function parseHostEntry(entry: string): { host: string; port?: number } | undefined {
  const lower = entry.toLowerCase();
  if (lower.length === 0 || lower.length > MAX_STRING_LENGTH || !/^[a-z0-9.:[\]-]+$/.test(lower)) {
    return undefined;
  }
  const split = lower.startsWith('[') ? lower.lastIndexOf(']:') + 1 : lower.lastIndexOf(':');
  const hasPort = lower.startsWith('[') ? split > 0 : split > -1;
  const host = hasPort ? lower.slice(0, split) : lower;
  const port = hasPort ? lower.slice(split + 1) : undefined;
  if (port !== undefined && (!PORT.test(port) || Number(port) > 65535)) return undefined;
  let canonical: string;
  try {
    canonical = new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
  if (canonical !== host || host.endsWith('.')) return undefined;
  if (
    !host.startsWith('[') &&
    host.split('.').some((label, i, all) => {
      const last = i === all.length - 1 && label === '';
      return !last && (label === '' || label.startsWith('-') || label.endsWith('-'));
    })
  ) {
    return undefined;
  }
  return port === undefined ? { host } : { host, port: Number(port) };
}

const PUBLIC_URL_MAX_LENGTH = 2048;

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function sameHost(a: string, b: string): boolean {
  const left = stripDots(a);
  const right = stripDots(b);
  return left === right || (isLoopback(left) && isLoopback(right));
}

function parseOrigin(value: unknown, limit = MAX_STRING_LENGTH): URL | undefined {
  if (typeof value !== 'string' || value.length > limit) return undefined;
  try {
    const url = new URL(value);
    const plain = url.protocol === 'https:' || url.protocol === 'http:';
    const clean = plain && !url.username && !url.password && !/^[a-z]+:\/\/[^/?#]*@/i.test(value);
    return clean && validHostname(url.hostname) ? url : undefined;
  } catch {
    return undefined;
  }
}

function validateContact(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STRING_LENGTH) {
    return 'must be a mailto: address or an https URL';
  }
  if (value.startsWith('mailto:')) {
    return MAILTO.test(value) ? undefined : 'must be a plain mailto: address';
  }
  if (!PRINTABLE_ASCII.test(value) || value.includes(' ')) return 'must be a plain https URL';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return 'must be a mailto: address or an https URL';
    if (url.username || url.password || url.search || url.hash || value.includes('?')) {
      return 'must not carry userinfo, a query or a fragment';
    }
    return undefined;
  } catch {
    return 'must be a mailto: address or an https URL';
  }
}

function validateAgent(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STRING_LENGTH) {
    return 'must be a non-empty string of at most 200 characters';
  }
  if (!PRINTABLE_ASCII.test(value)) return 'must be printable ASCII';
  if (agentLooksLikeCredential(value)) {
    return 'looks like a credential value';
  }
  return undefined;
}

export function validateRegistryConfig(input: unknown, target: Platform): readonly string[] {
  if (!PLATFORMS.includes(target)) return ['target: unknown platform'];
  if (input === undefined) return [];
  if (!isObject(input)) return ['registry: must be an object'];

  const problems: string[] = [];
  for (const key of Object.keys(input)) {
    if (!ROOT_KEYS.includes(key)) problems.push(`registry.${safeKey(key)}: unknown key`);
  }

  function section(name: keyof typeof SECTION_KEYS): Obj | undefined {
    const value = own(input as Obj, name);
    if (value === undefined) return undefined;
    if (!isObject(value)) {
      problems.push(`registry.${name}: must be an object`);
      return undefined;
    }
    for (const key of Object.keys(value)) {
      if (!(SECTION_KEYS[name] as readonly string[]).includes(key)) {
        problems.push(`registry.${name}.${safeKey(key)}: unknown key`);
      }
    }
    return value;
  }

  const outbound = section('outbound');
  const hosts = outbound ? own(outbound, 'allowPrivateHosts') : undefined;
  if (hosts !== undefined) {
    const at = 'registry.outbound.allowPrivateHosts';
    if (!Array.isArray(hosts)) {
      problems.push(`${at}: must be an array`);
    } else if (hosts.length > 0 && target === 'cloudflare') {
      problems.push(`${at}: not available on cloudflare`);
    } else {
      const seen = new Set<string>();
      hosts.forEach((entry: unknown, index) => {
        const parsed = typeof entry === 'string' ? parseHostEntry(entry) : undefined;
        if (typeof entry !== 'string' || !parsed) {
          problems.push(`${at}[${index}]: must be an exact host or host:port`);
        } else if (seen.has(entry.toLowerCase())) {
          problems.push(`${at}[${index}]: duplicate entry`);
        } else {
          seen.add(entry.toLowerCase());
        }
      });
    }
  }

  const extras = outbound ? own(outbound, 'extraSelfOrigins') : undefined;
  if (extras !== undefined) {
    const at = 'registry.outbound.extraSelfOrigins';
    if (!Array.isArray(extras) || extras.length > MAX_EXTRA_SELF_ORIGINS) {
      problems.push(`${at}: must be an array of at most ${MAX_EXTRA_SELF_ORIGINS} origins`);
    } else {
      extras.forEach((entry: unknown, index) => {
        if (!parseOrigin(entry))
          problems.push(`${at}[${index}]: must be an absolute http(s) origin`);
      });
    }
  }

  const userAgent = section('userAgent');
  if (userAgent) {
    for (const key of SECTION_KEYS.userAgent) {
      const value = own(userAgent, key);
      const problem = value === undefined ? undefined : validateAgent(value);
      if (problem) problems.push(`registry.userAgent.${key}: ${problem}`);
    }
  }

  const contact = own(input, 'upstreamContact');
  if (contact !== undefined) {
    const problem = validateContact(contact);
    if (problem) problems.push(`registry.upstreamContact: ${problem}`);
  }

  const timers = section('timers');
  if (timers) {
    for (const key of SECTION_KEYS.timers) {
      const value = own(timers, key);
      if (value === undefined) continue;
      if (!positiveInteger(value)) {
        problems.push(`registry.timers.${key}: must be a positive integer`);
      } else if (value > TIMER_LIMITS[key]) {
        problems.push(`registry.timers.${key}: exceeds the maximum`);
      }
    }
  }

  const caps = section('caps');
  if (caps) {
    const limits = { metadataBytes: MAX_METADATA_BYTES, archiveBytes: MAX_ARCHIVE_BYTES };
    for (const key of SECTION_KEYS.caps) {
      const value = own(caps, key);
      if (value === undefined) continue;
      if (!positiveInteger(value)) {
        problems.push(`registry.caps.${key}: must be a positive integer`);
      } else if (value > limits[key]) {
        problems.push(`registry.caps.${key}: exceeds the product cap`);
      }
    }
  }

  return problems;
}

function effectivePort(url: URL): number {
  return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
}

function selfOrigin(url: URL): string {
  return `${url.protocol}//${stripDots(url.hostname)}${url.port ? `:${url.port}` : ''}`;
}

export function resolveRegistryConfig(
  input: RegistryConfigInput | undefined,
  target: Platform,
  publicUrl: string,
): RegistryConfig {
  const problems = [...validateRegistryConfig(input, target)];
  const self = parseOrigin(publicUrl, PUBLIC_URL_MAX_LENGTH);
  if (typeof publicUrl === 'string' && publicUrl.length > PUBLIC_URL_MAX_LENGTH) {
    problems.push(`PB_PUBLIC_URL: must be at most ${PUBLIC_URL_MAX_LENGTH} characters`);
  } else if (!self) {
    problems.push('PB_PUBLIC_URL: must be an absolute http(s) URL without userinfo');
  }
  if (problems.length > 0 || !self) throw new RegistryConfigError(problems);

  const root: Obj = isObject(input) ? input : {};
  const sub = (name: string): Obj => {
    const value = own(root, name);
    return isObject(value) ? value : {};
  };
  const outbound = sub('outbound');
  const hosts = own(outbound, 'allowPrivateHosts') as readonly string[] | undefined;
  const extraOrigins = own(outbound, 'extraSelfOrigins') as readonly string[] | undefined;
  const allowPrivateHosts = (hosts ?? []).map((h) => h.toLowerCase());
  const extras = (extraOrigins ?? []).map((o) => new URL(o));
  const selfHost = stripDots(self.hostname);
  allowPrivateHosts.forEach((entry, index) => {
    const parsed = parseHostEntry(entry);
    const clash =
      parsed &&
      (sameHost(parsed.host, selfHost) ||
        extras.some(
          (extra) =>
            sameHost(extra.hostname, parsed.host) &&
            (parsed.port === undefined || parsed.port === effectivePort(extra)),
        ));
    if (clash) {
      problems.push(`registry.outbound.allowPrivateHosts[${index}]: is the broker's own host`);
    }
  });
  if (problems.length > 0) throw new RegistryConfigError(problems);

  const selfOrigins = [...new Set([self, ...extras].map(selfOrigin))];
  const d = REGISTRY_DEFAULTS;
  const ua = sub('userAgent');
  const t = sub('timers');
  const c = sub('caps');
  const num = (o: Obj, k: string, fallback: number): number =>
    (own(o, k) as number | undefined) ?? fallback;
  const str = (o: Obj, k: string, fallback: string): string =>
    (own(o, k) as string | undefined) ?? fallback;
  return {
    outbound: { allowPrivateHosts, selfOrigins },
    userAgent: {
      default: str(ua, 'default', d.userAgent.default),
      composerStyle: str(ua, 'composerStyle', d.userAgent.composerStyle),
    },
    upstreamContact: str(root, 'upstreamContact', d.upstreamContact),
    timers: {
      metadataTtlSeconds: num(t, 'metadataTtlSeconds', d.timers.metadataTtlSeconds),
      negativeTtlSeconds: num(t, 'negativeTtlSeconds', d.timers.negativeTtlSeconds),
      waitBudgetMs: num(t, 'waitBudgetMs', d.timers.waitBudgetMs),
    },
    caps: {
      metadataBytes: num(c, 'metadataBytes', d.caps.metadataBytes),
      archiveBytes: num(c, 'archiveBytes', d.caps.archiveBytes),
    },
  };
}
