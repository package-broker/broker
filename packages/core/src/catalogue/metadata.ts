export const MAX_METADATA_BYTES = 262144;
export const MAX_METADATA_DEPTH = 32;

export type MetadataEcosystem = 'composer' | 'npm';

export interface NormalizedMetadata {
  json: string;
  license: string | null;
  deprecatedMessage: string | null;
  composerShasum: string | null;
  npmIntegrity: string | null;
}

export class MetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetadataError';
  }
}

export class MetadataTooLargeError extends MetadataError {
  constructor() {
    super('version metadata exceeds the size cap');
    this.name = 'MetadataTooLargeError';
  }
}

type Json = Record<string, unknown>;

const ENCODER = new TextEncoder();
const MAX_URL_LENGTH = 4096;

const DENIED_QUERY = new Set([
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
]);
const SHA1_HEX = /^[0-9a-fA-F]{40}$/;
const SCP_GIT = /^git@[^\s/:@]+:[^\s]+$/;
const SRI_ENTRY =
  /^(?:(sha512)-[A-Za-z0-9+/]{86}==|sha384-[A-Za-z0-9+/]{64}|sha256-[A-Za-z0-9+/]{43}=|(sha1)-[A-Za-z0-9+/]{27}=)(?:\?\S*)?$/;

function isPlainObject(value: unknown): value is Json {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function serialize(value: unknown, depth: number): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new MetadataError('metadata contains a non-finite number');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new MetadataError('metadata contains an unsupported value');
  }
  if (depth > MAX_METADATA_DEPTH) throw new MetadataError('metadata is nested too deeply');
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new MetadataError('metadata contains a sparse array');
      items.push(serialize(value[index], depth + 1));
    }
    return `[${items.join(',')}]`;
  }
  if (!isPlainObject(value)) throw new MetadataError('metadata contains a non-plain object');
  const entries = Object.keys(value)
    .filter((key) => key !== '__proto__')
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(value[key], depth + 1)}`);
  return `{${entries.join(',')}}`;
}

function guarded<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof MetadataError) throw error;
    throw new MetadataError('metadata could not be read');
  }
}

export function canonicalJson(value: unknown): string {
  return guarded(() => serialize(value, 1));
}

function decodeName(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function deniedName(raw: string): boolean {
  const decoded = decodeName(raw.split('=')[0] ?? '');
  if (decoded === null) return true;
  const name = decoded
    .replace(/(\[[^\]]*\])+$/, '')
    .trim()
    .replace(/[. ]/g, '_');
  return DENIED_QUERY.has(name.toLowerCase());
}

function hasDeniedParameter(text: string): boolean {
  return text.split(/[&;]/).some(deniedName);
}

function checkDistUrl(value: unknown): void {
  if (typeof value !== 'string') throw new MetadataError('dist url must be a string');
  if (value.length > MAX_URL_LENGTH) throw new MetadataError('dist url is too long');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MetadataError('dist url is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new MetadataError('dist url scheme must be http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new MetadataError('dist url must not carry credentials');
  }
  if (url.hash !== '') throw new MetadataError('dist url must not carry a fragment');
  if (hasDeniedParameter(url.search.slice(1))) {
    throw new MetadataError('dist url must not carry credential parameters');
  }
}

function sourceAllowed(value: unknown): boolean {
  if (!isPlainObject(value) || typeof value.url !== 'string') return false;
  if (value.url.length > MAX_URL_LENGTH) return false;
  if (SCP_GIT.test(value.url)) return !/[?#]/.test(value.url);
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return false;
  }
  if (!['https:', 'http:', 'git:', 'ssh:'].includes(url.protocol)) return false;
  if (url.password !== '' || (url.username !== '' && url.username !== 'git')) return false;
  return !hasDeniedParameter(url.search.slice(1)) && !hasDeniedParameter(url.hash.slice(1));
}

function sha1Field(value: unknown, allowEmpty: boolean): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new MetadataError('shasum must be a string');
  if (value === '' && allowEmpty) return null;
  if (!SHA1_HEX.test(value)) throw new MetadataError('shasum must be 40 hex characters');
  return value.toLowerCase();
}

function integrityField(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new MetadataError('integrity must be a string');
  const entries = value.split(/\s+/).filter((entry) => entry !== '');
  let strong = false;
  for (const entry of entries) {
    const match = SRI_ENTRY.exec(entry);
    if (match === null) throw new MetadataError('integrity entry is malformed');
    if (match[1] !== undefined || match[2] !== undefined) strong = true;
  }
  if (!strong) throw new MetadataError('integrity needs a sha512 or sha1 entry');
  return entries.join(' ');
}

function distOf(input: Json): Json | null {
  if (input.dist === undefined || input.dist === null) return null;
  if (!isPlainObject(input.dist)) throw new MetadataError('dist must be an object');
  return input.dist;
}

function licenseType(value: unknown): string | null {
  return isPlainObject(value) && typeof value.type === 'string' && value.type !== ''
    ? value.type
    : null;
}

function licenseOf(input: Json, ecosystem: MetadataEcosystem): string | null {
  const { license, licenses } = input;
  if (typeof license === 'string') return license === '' ? null : license;
  if (Array.isArray(license)) return canonicalJson(license);
  if (ecosystem !== 'npm') return null;
  const single = licenseType(license);
  if (single !== null) return single;
  if (Array.isArray(licenses)) {
    const types = licenses
      .map((entry) => (typeof entry === 'string' && entry !== '' ? entry : licenseType(entry)))
      .filter((type): type is string => type !== null);
    return types.length > 0 ? canonicalJson(types) : null;
  }
  return null;
}

export function normalizeVersionMetadata(
  ecosystem: MetadataEcosystem,
  input: unknown,
): NormalizedMetadata {
  return guarded(() => normalize(ecosystem, input));
}

function normalize(ecosystem: MetadataEcosystem, input: unknown): NormalizedMetadata {
  if (!isPlainObject(input)) throw new MetadataError('version metadata must be an object');
  const result: Json = { ...input };
  const dist = distOf(result);
  let deprecatedMessage: string | null = null;
  let composerShasum: string | null = null;
  let npmIntegrity: string | null = null;

  if (ecosystem === 'npm') {
    delete result.readme;
    delete result.readmeFilename;
    if (typeof result.deprecated === 'string' && result.deprecated !== '') {
      deprecatedMessage = result.deprecated;
    }
    delete result.deprecated;
    if (dist !== null) {
      if (dist.tarball !== undefined) checkDistUrl(dist.tarball);
      npmIntegrity = integrityField(dist.integrity);
      sha1Field(dist.shasum, false);
    }
  } else {
    if (dist !== null) {
      if (dist.url !== undefined) checkDistUrl(dist.url);
      if (dist.mirrors !== undefined) {
        if (!Array.isArray(dist.mirrors)) throw new MetadataError('dist mirrors must be a list');
        for (const mirror of dist.mirrors as unknown[]) {
          checkDistUrl(isPlainObject(mirror) ? mirror.url : mirror);
        }
      }
      composerShasum = sha1Field(dist.shasum, true);
    }
    if (result.source !== undefined && !sourceAllowed(result.source)) delete result.source;
  }

  const json = canonicalJson(result);
  if (ENCODER.encode(json).length > MAX_METADATA_BYTES) throw new MetadataTooLargeError();
  return {
    json,
    license: licenseOf(result, ecosystem),
    deprecatedMessage,
    composerShasum,
    npmIntegrity,
  };
}
