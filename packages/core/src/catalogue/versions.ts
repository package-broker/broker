import { normalizeVersion } from '../registry/composer/version-parser.js';

export type VersionEcosystem = 'composer' | 'npm';
export type VersionStability = 'dev' | 'alpha' | 'beta' | 'RC' | 'stable';

export interface VersionPair {
  ecosystem: VersionEcosystem;
  version: string;
  versionNormalized: string;
}

export class VersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionError';
  }
}

const COMPOSER_NUMERIC = /^\d+(?:\.\d+)*(?:-(alpha|beta|RC|patch)[\d.-]*)?(?:-dev)?$/;
const COMPOSER_STABILITY_FLAG = /@(?:stable|RC|beta|alpha|dev)$/i;
const WHITESPACE = /\s/;
const COMPOSER_BRANCH = /^dev-\S+$/;
const MAX_COMPOSER_LENGTH = 255;
const MAX_NPM_LENGTH = 256;
const NPM_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const NPM_STABILITY = /^(alpha|beta|rc)\d*$/;

function fail(message: string): never {
  throw new VersionError(message);
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function validateComposer(version: string, versionNormalized: string): VersionStability {
  if (version.length > MAX_COMPOSER_LENGTH || versionNormalized.length > MAX_COMPOSER_LENGTH) {
    fail('composer version too long');
  }
  if (
    hasControl(version) ||
    hasControl(versionNormalized) ||
    WHITESPACE.test(version) ||
    COMPOSER_STABILITY_FLAG.test(version)
  ) {
    fail('invalid composer version');
  }
  const branch = COMPOSER_BRANCH.test(versionNormalized);
  if (!branch && !COMPOSER_NUMERIC.test(versionNormalized)) {
    fail('invalid composer normalized version');
  }
  let expected: string;
  try {
    expected = normalizeVersion(version);
  } catch {
    return fail('invalid composer version');
  }
  if (expected !== versionNormalized) {
    fail('composer version does not match its normalized form');
  }
  if (branch || versionNormalized.endsWith('-dev')) {
    return 'dev';
  }
  const kind = COMPOSER_NUMERIC.exec(versionNormalized)?.[1];
  return kind === 'alpha' || kind === 'beta' || kind === 'RC' ? kind : 'stable';
}

/**
 * npm stability comes from the first prerelease identifier: alpha, beta or rc
 * (case-insensitive) optionally followed by digits only; anything else is alpha.
 */
function validateNpm(version: string, versionNormalized: string): VersionStability {
  if (version.length > MAX_NPM_LENGTH || versionNormalized.length > MAX_NPM_LENGTH) {
    fail('npm version too long');
  }
  const match = NPM_SEMVER.exec(version);
  if (!match) {
    fail('invalid npm version');
  }
  if (versionNormalized !== version) {
    fail('npm normalized version must equal the version');
  }
  if ([match[1], match[2], match[3]].some((part) => !Number.isSafeInteger(Number(part)))) {
    fail('npm version number exceeds the safe integer range');
  }
  const prerelease = match[4];
  if (prerelease === undefined) {
    return 'stable';
  }
  const first = (prerelease.split('.')[0] ?? '').toLowerCase();
  const kind = NPM_STABILITY.exec(first)?.[1];
  return kind === 'rc' ? 'RC' : kind === 'beta' ? 'beta' : 'alpha';
}

export function validateVersion(pair: VersionPair): { stability: VersionStability } {
  if (pair.ecosystem === 'composer') {
    return { stability: validateComposer(pair.version, pair.versionNormalized) };
  }
  if (pair.ecosystem === 'npm') {
    return { stability: validateNpm(pair.version, pair.versionNormalized) };
  }
  return fail('unknown ecosystem');
}

export function compareNpmVersions(a: string, b: string): number {
  validateVersion({ ecosystem: 'npm', version: a, versionNormalized: a });
  validateVersion({ ecosystem: 'npm', version: b, versionNormalized: b });
  const parts = (value: string) => {
    const [core, pre] = value.split(/-(.*)/s);
    return { core: core!.split('.').map(BigInt), pre: pre?.split('.') };
  };
  const x = parts(a),
    y = parts(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! > y.core[i]! ? 1 : -1;
  if (!x.pre || !y.pre) return x.pre === y.pre ? 0 : x.pre ? -1 : 1;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const l = x.pre[i]!,
      r = y.pre[i]!;
    if (l === r) continue;
    const ln = /^\d+$/.test(l),
      rn = /^\d+$/.test(r);
    if (ln && rn) return BigInt(l) > BigInt(r) ? 1 : -1;
    if (ln !== rn) return ln ? -1 : 1;
    return l > r ? 1 : -1;
  }
  return Math.sign(x.pre.length - y.pre.length);
}
