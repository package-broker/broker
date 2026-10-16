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
import { normalizeVersion } from './version-parser.js';

export interface ComposerVersionOrigin {
  readonly probe: CredentialEchoProbe;
  readonly importedAt: string;
}

export type ComposerVersionSkip =
  | 'malformed'
  | 'foreign_name'
  | 'invalid_version'
  | 'normalized_mismatch'
  | 'credential_echo'
  | 'invalid_metadata'
  | 'no_installable_reference'
  | 'too_large';

export type ComposerVersionResult =
  | { readonly ok: true; readonly input: VersionInput; readonly stripped: number }
  | { readonly ok: false; readonly reason: ComposerVersionSkip };

const ALLOWED_KEYS = new Set([
  'name',
  'version',
  'version_normalized',
  'description',
  'keywords',
  'homepage',
  'readme',
  'time',
  'license',
  'authors',
  'support',
  'funding',
  'type',
  'autoload',
  'autoload-dev',
  'include-path',
  'target-dir',
  'bin',
  'require',
  'require-dev',
  'conflict',
  'replace',
  'provide',
  'suggest',
  'extra',
  'archive',
  'abandoned',
  'default-branch',
  'dist',
  'source',
]);
export const MAX_RELEASE_SKEW_MS = 24 * 60 * 60 * 1000;
export const MIN_COMPOSER_RELEASE_TIME = '2011-01-01T00:00:00.000Z';
const MIN_COMPOSER_RELEASE_MS = Date.parse(MIN_COMPOSER_RELEASE_TIME);
const DEFAULT_BRANCH_ALIAS = '9999999-dev';
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/;

export class InvalidComposerOriginError extends TypeError {
  constructor() {
    super('importedAt must be a canonical ISO timestamp');
    this.name = 'InvalidComposerOriginError';
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function skip(reason: ComposerVersionSkip): ComposerVersionResult {
  return { ok: false, reason };
}

function sameName(key: string, name: unknown): boolean {
  if (typeof name !== 'string') return false;
  try {
    return packageKey(name, { ecosystem: 'composer' }) === key;
  } catch {
    return false;
  }
}

function releasedAt(time: unknown, importedAt: string): string | null {
  if (typeof time !== 'string') return null;
  let ms: number;
  if (/^\d+$/.test(time)) {
    ms = Number(time) * 1000;
  } else {
    const match = TIME.exec(time);
    if (match === null) return null;
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const local = Date.UTC(year, month - 1, day, hour, minute, second);
    const check = new Date(local);
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day ||
      check.getUTCHours() !== hour
    ) {
      return null;
    }
    const zone = match[8];
    let offset = 0;
    if (zone !== undefined && zone !== 'Z') {
      const offsetHours = Number(zone.slice(1, 3));
      const offsetMinutes = Number(zone.slice(4, 6));
      if (offsetHours > 23 || offsetMinutes > 59) return null;
      offset = (offsetHours * 60 + offsetMinutes) * 60000 * (zone.startsWith('-') ? -1 : 1);
    }
    ms = local - offset + Number((match[7] ?? '').slice(0, 3).padEnd(3, '0'));
  }
  const date = new Date(ms);
  const parsed = date.getTime();
  if (Number.isNaN(parsed)) return null;
  if (parsed < MIN_COMPOSER_RELEASE_MS || parsed > Date.parse(importedAt) + MAX_RELEASE_SKEW_MS) {
    return null;
  }
  return date.toISOString();
}

function usableDist(dist: unknown): dist is Json & { type: 'zip' | 'tar' } {
  return (
    isRecord(dist) &&
    (dist.type === 'zip' || dist.type === 'tar') &&
    typeof dist.url === 'string' &&
    dist.url !== ''
  );
}

function stringField(block: Json, name: string): string | undefined {
  const value = block[name];
  return typeof value === 'string' ? value : undefined;
}

function rebuiltDist(dist: Json): Json {
  const rebuilt: Json = {};
  for (const name of ['type', 'url', 'reference', 'shasum']) {
    if (dist[name] !== undefined) rebuilt[name] = dist[name];
  }
  return rebuilt;
}

export function composerVersionInput(
  key: string,
  rawVersionObject: unknown,
  origin: ComposerVersionOrigin,
): ComposerVersionResult {
  if (!CANONICAL_TIMESTAMP.test(origin.importedAt)) throw new InvalidComposerOriginError();
  if (!isRecord(rawVersionObject)) return skip('malformed');

  const allowed: Json = {};
  for (const [name, value] of Object.entries(rawVersionObject)) {
    if (ALLOWED_KEYS.has(name)) allowed[name] = value;
  }

  const echo = stripCredentialEcho(allowed, origin.probe);
  if (echo.refused) return skip(echo.reason === 'malformed' ? 'malformed' : 'credential_echo');
  const echoed = echo.object as Json;

  if (!sameName(key, echoed.name)) return skip('foreign_name');

  const { version, version_normalized: upstreamNormalized } = echoed;
  if (typeof version !== 'string') return skip('invalid_version');
  let computed: string;
  try {
    computed = normalizeVersion(version);
  } catch {
    return skip('invalid_version');
  }
  const upstreamPresent =
    typeof upstreamNormalized === 'string' && upstreamNormalized !== DEFAULT_BRANCH_ALIAS;
  if (upstreamPresent && upstreamNormalized !== computed) {
    return skip('normalized_mismatch');
  }
  try {
    validateVersion({ ecosystem: 'composer', version, versionNormalized: computed });
  } catch {
    return skip('invalid_version');
  }

  const object: Json = { ...echoed };
  if (upstreamNormalized !== undefined && !upstreamPresent) delete object.version_normalized;

  if (usableDist(object.dist)) {
    object.dist = rebuiltDist(object.dist);
    delete object.source;
  } else {
    delete object.dist;
  }

  let metadata;
  try {
    metadata = normalizeVersionMetadata('composer', object);
  } catch (error) {
    if (error instanceof MetadataTooLargeError) return skip('too_large');
    if (error instanceof MetadataError) return skip('invalid_metadata');
    throw error;
  }

  const stored = JSON.parse(metadata.json) as Json;
  const dist = isRecord(stored.dist) ? stored.dist : null;
  const source = isRecord(stored.source) ? stored.source : null;
  if (dist === null && source === null) return skip('no_installable_reference');

  const released = releasedAt(stored.time, origin.importedAt);
  return {
    ok: true,
    stripped: echo.stripped.length,
    input: {
      version,
      versionNormalized: computed,
      license: metadata.license,
      distType: dist === null ? null : (dist.type as 'zip' | 'tar'),
      sourceRef:
        (dist === null ? undefined : stringField(dist, 'reference')) ??
        (source === null ? undefined : stringField(source, 'reference')) ??
        null,
      upstreamReleasedAt: released,
      metadata,
      history:
        released === null
          ? { basis: 'import_time', at: origin.importedAt, noOtherDate: true }
          : { basis: 'release_date', at: released },
    },
  };
}
