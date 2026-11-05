import {
  MetadataError,
  MetadataTooLargeError,
  normalizeVersionMetadata,
} from '../../catalogue/metadata.js';
import { packageKey } from '../../catalogue/names.js';
import { validateVersion } from '../../catalogue/versions.js';
import type { VersionInput } from '../../db/catalogue.js';
import { stripCredentialEcho } from '../../sources/credential-echo.js';
import type { CredentialEchoProbe } from '../../sources/credentials.js';

export interface NpmVersionOrigin {
  readonly kind?: 'vcs';
  readonly probe: CredentialEchoProbe;
  readonly importedAt: string;
}

export type NpmVersionSkip =
  | 'malformed'
  | 'foreign_name'
  | 'invalid_version'
  | 'credential_echo'
  | 'invalid_metadata'
  | 'no_installable_reference'
  | 'no_digest'
  | 'too_large';

export type NpmVersionResult =
  | { readonly ok: true; readonly input: VersionInput; readonly stripped: number }
  | { readonly ok: false; readonly reason: NpmVersionSkip };

const ALLOWED_KEYS = new Set([
  'name',
  'version',
  'description',
  'keywords',
  'homepage',
  'bugs',
  'license',
  'licenses',
  'author',
  'contributors',
  'maintainers',
  'funding',
  'repository',
  'type',
  'main',
  'module',
  'types',
  'typings',
  'exports',
  'imports',
  'browser',
  'bin',
  'man',
  'directories',
  'scripts',
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'optionalDependencies',
  'bundleDependencies',
  'bundledDependencies',
  'acceptDependencies',
  'engines',
  'os',
  'cpu',
  'libc',
  'deprecated',
  'gitHead',
  'hasInstallScript',
  '_hasShrinkwrap',
  '_npmUser',
  '_npmVersion',
  '_nodeVersion',
  'gypfile',
  'dist',
]);
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const EARLIEST_RELEASE = Date.UTC(2009, 0, 1);
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA1_HEX = /^[0-9a-fA-F]{40}$/;
const EMAIL_TOKEN = /\S*@\S*/g;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];
const MAX_SIGNATURES = 16;
const DENIED_QUERY = [
  'token',
  'access_token',
  'private_token',
  'auth',
  'key',
  'signature',
  'sig',
  'x-amz-signature',
  'x-amz-credential',
  'x-goog-signature',
];

export class InvalidNpmOriginError extends TypeError {
  constructor() {
    super('importedAt must be a canonical ISO timestamp');
    this.name = 'InvalidNpmOriginError';
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCalendarTimestamp(value: string): boolean {
  if (!CANONICAL_TIMESTAMP.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function skip(reason: NpmVersionSkip): NpmVersionResult {
  return { ok: false, reason };
}

function sameName(key: string, name: unknown): boolean {
  if (typeof name !== 'string') return false;
  try {
    return packageKey(name, { ecosystem: 'npm', legacyCase: true }) === key;
  } catch {
    return false;
  }
}

function releasedAt(time: unknown, version: string, importedAt: string): string | null {
  if (!isRecord(time) || !Object.hasOwn(time, version)) return null;
  const value = time[version];
  if (typeof value !== 'string') return null;
  const match = TIME.exec(value);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (hour > 23 || minute > 59 || second > 59) return null;
  const local = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(local);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  const zone = match[8] ?? 'Z';
  let offset = 0;
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    offset = (offsetHours * 60 + offsetMinutes) * 60000 * (zone.startsWith('-') ? -1 : 1);
  }
  const ms = local - offset + Number((match[7] ?? '').slice(0, 3).padEnd(3, '0'));
  if (ms < EARLIEST_RELEASE || ms > Date.parse(importedAt) + FUTURE_SLACK_MS) return null;
  return new Date(ms).toISOString();
}

function decodeName(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function deniedParameter(pair: string, denied: ReadonlySet<string>): boolean {
  const decoded = decodeName(pair.split('=')[0] ?? '');
  if (decoded === null) return true;
  const name = decoded
    .replace(/(\[[^\]]*\])+$/, '')
    .trim()
    .replace(/[. ]/g, '_')
    .toLowerCase();
  return denied.has(name);
}

function withoutDenied(part: string, denied: ReadonlySet<string>): string {
  return part
    .split(/[&;]/)
    .filter((pair) => pair !== '' && !deniedParameter(pair, denied))
    .join('&');
}

function cleanUrl(url: string, denied: ReadonlySet<string>): string {
  const hashAt = url.indexOf('#');
  const head = hashAt === -1 ? url : url.slice(0, hashAt);
  let hash = hashAt === -1 ? '' : url.slice(hashAt + 1);
  const queryAt = head.indexOf('?');
  let base = head;
  if (queryAt !== -1) {
    const query = withoutDenied(head.slice(queryAt + 1), denied);
    base = head.slice(0, queryAt) + (query === '' ? '' : `?${query}`);
  }
  if (hash.includes('=')) hash = withoutDenied(hash, denied);
  return hash === '' ? base : `${base}#${hash}`;
}

function isMailto(url: string): boolean {
  return url.trim().toLowerCase().startsWith('mailto:');
}

function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function cleanText(text: string): string | undefined {
  if (!text.includes('@')) return text;
  const kept = (text.split('<')[0] ?? '').replace(EMAIL_TOKEN, '').trim();
  return kept === '' ? undefined : kept;
}

function person(value: unknown, denied: ReadonlySet<string>): unknown {
  if (typeof value === 'string') return cleanText(value);
  if (!isRecord(value)) return undefined;
  const kept: Json = {};
  const name = typeof value.name === 'string' ? cleanText(value.name) : undefined;
  if (name !== undefined) kept.name = name;
  if (typeof value.url === 'string' && !isMailto(value.url)) kept.url = cleanUrl(value.url, denied);
  return Object.keys(kept).length === 0 ? undefined : kept;
}

function people(value: unknown, denied: ReadonlySet<string>): unknown {
  if (!Array.isArray(value)) return person(value, denied);
  const list = value.map((entry) => person(entry, denied)).filter((entry) => entry !== undefined);
  return list.length === 0 ? undefined : list;
}

function bugs(value: unknown, denied: ReadonlySet<string>): unknown {
  const url = isRecord(value) ? value.url : value;
  if (typeof url !== 'string' || !isHttpUrl(url)) return undefined;
  const cleaned = cleanUrl(url, denied);
  return isRecord(value) ? { url: cleaned } : cleaned;
}

function withCleanUrl(value: unknown, denied: ReadonlySet<string>): unknown {
  if (typeof value === 'string') return cleanUrl(value, denied);
  if (Array.isArray(value)) return value.map((entry) => withCleanUrl(entry, denied));
  if (isRecord(value) && typeof value.url === 'string') {
    return { ...value, url: cleanUrl(value.url, denied) };
  }
  return value;
}

function assign(object: Json, name: string, value: unknown): void {
  if (value === undefined) delete object[name];
  else object[name] = value;
}

function scrub(object: Json, denied: ReadonlySet<string>): void {
  for (const name of ['author', 'contributors', 'maintainers', '_npmUser']) {
    if (object[name] !== undefined) assign(object, name, people(object[name], denied));
  }
  if (object.bugs !== undefined) assign(object, 'bugs', bugs(object.bugs, denied));
  for (const name of ['homepage', 'repository', 'funding']) {
    if (object[name] !== undefined) object[name] = withCleanUrl(object[name], denied);
  }
}

function hasInstallScript(object: Json): boolean {
  const { scripts } = object;
  const scripted =
    isRecord(scripts) &&
    INSTALL_SCRIPTS.some((name) => typeof scripts[name] === 'string' && scripts[name] !== '');
  return scripted || object.gypfile === true;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function signatures(value: unknown): Json[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_SIGNATURES) return undefined;
  const list: Json[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry) || typeof entry.keyid !== 'string' || typeof entry.sig !== 'string') {
      return undefined;
    }
    list.push({ keyid: entry.keyid, sig: entry.sig });
  }
  return list;
}

function attestations(value: unknown): Json | undefined {
  if (!isRecord(value) || typeof value.url !== 'string' || !isRecord(value.provenance)) {
    return undefined;
  }
  const { predicateType } = value.provenance;
  if (typeof predicateType !== 'string') return undefined;
  try {
    if (new URL(value.url).protocol !== 'https:') return undefined;
  } catch {
    return undefined;
  }
  return { url: value.url, provenance: { predicateType } };
}

function rebuiltDist(dist: Json & { tarball: string }): Json {
  const rebuilt: Json = { tarball: dist.tarball };
  const { integrity, shasum } = dist;
  if (typeof integrity === 'string') {
    rebuilt.integrity = integrity
      .split(/\s+/)
      .filter((entry) => entry !== '')
      .join(' ');
  } else if (integrity !== undefined && integrity !== null) {
    rebuilt.integrity = integrity;
  }
  if (typeof shasum === 'string' && SHA1_HEX.test(shasum)) rebuilt.shasum = shasum.toLowerCase();
  else if (shasum !== undefined && shasum !== null) rebuilt.shasum = shasum;
  if (count(dist.fileCount)) rebuilt.fileCount = dist.fileCount;
  if (count(dist.unpackedSize)) rebuilt.unpackedSize = dist.unpackedSize;
  const signed = signatures(dist.signatures);
  if (signed !== undefined) rebuilt.signatures = signed;
  const attested = attestations(dist.attestations);
  if (attested !== undefined) rebuilt.attestations = attested;
  return rebuilt;
}

export function npmVersionInput(
  key: string,
  manifest: unknown,
  time: unknown,
  origin: NpmVersionOrigin,
): NpmVersionResult {
  if (!isCalendarTimestamp(origin.importedAt)) throw new InvalidNpmOriginError();
  if (!isRecord(manifest)) return skip('malformed');

  const allowed: Json = {};
  for (const [name, value] of Object.entries(manifest)) {
    if (ALLOWED_KEYS.has(name)) allowed[name] = value;
  }

  const echo = stripCredentialEcho(allowed, origin.probe);
  if (echo.refused) return skip(echo.reason === 'malformed' ? 'malformed' : 'credential_echo');
  const object = echo.object as Json;

  if (!sameName(key, object.name)) return skip('foreign_name');

  const { version } = object;
  if (typeof version !== 'string') return skip('invalid_version');
  try {
    validateVersion({ ecosystem: 'npm', version, versionNormalized: version });
  } catch {
    return skip('invalid_version');
  }

  const denied = new Set([
    ...DENIED_QUERY,
    ...origin.probe.queryParams.map((name) => name.toLowerCase()),
  ]);
  scrub(object, denied);
  if (hasInstallScript(object)) object.hasInstallScript = true;
  else delete object.hasInstallScript;

  if (origin.kind === 'vcs') {
    if (typeof object.gitHead !== 'string' || !GIT_SHA.test(object.gitHead)) {
      return skip('no_installable_reference');
    }
    delete object.dist;
  } else {
    const { dist } = object;
    if (!isRecord(dist) || typeof dist.tarball !== 'string' || dist.tarball === '') {
      return skip('no_installable_reference');
    }
    const rebuilt = rebuiltDist(dist as Json & { tarball: string });
    if (rebuilt.integrity === undefined && rebuilt.shasum === undefined) return skip('no_digest');
    object.dist = rebuilt;
  }

  let metadata;
  try {
    metadata = normalizeVersionMetadata('npm', object);
  } catch (error) {
    if (error instanceof MetadataTooLargeError) return skip('too_large');
    if (error instanceof MetadataError) return skip('invalid_metadata');
    throw error;
  }

  const released = releasedAt(time, version, origin.importedAt);
  return {
    ok: true,
    stripped: echo.stripped.length,
    input: {
      version,
      versionNormalized: version,
      license: metadata.license,
      distType: 'tgz',
      sourceRef:
        typeof object.gitHead === 'string' && GIT_SHA.test(object.gitHead) ? object.gitHead : null,
      upstreamReleasedAt: released,
      metadata,
      history:
        released === null
          ? { basis: 'import_time', at: origin.importedAt, noOtherDate: true }
          : { basis: 'release_date', at: released },
    },
  };
}
