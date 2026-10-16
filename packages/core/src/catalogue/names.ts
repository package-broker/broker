export const MAX_NPM_NAME_LENGTH = 214;
export const MAX_KEY_LENGTH = 428;

export type NameEcosystem = 'composer' | 'npm';

export interface PackageKeyOptions {
  ecosystem: NameEcosystem;
  legacyCase?: boolean;
}

export class PackageNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageNameError';
  }
}

const COMPOSER_NAME = /^[a-z0-9]+(?:[_.-][a-z0-9]+)*\/[a-z0-9]+(?:(?:[_.]|-{1,2})[a-z0-9]+)*$/i;
const NPM_CHARACTERS = /^[A-Za-z0-9._~-]+$/;
const NPM_RESERVED = new Set(['node_modules', 'favicon.ico']);
const CAPITAL = /[A-Z]/g;
const ENCODED_CAPITAL = /!([a-z])/g;

function composerKey(name: string): string {
  if (name.length > MAX_KEY_LENGTH || !COMPOSER_NAME.test(name)) {
    throw new PackageNameError('invalid composer package name');
  }
  return name.toLowerCase();
}

function npmKey(name: string, legacyCase: boolean): string {
  if (name.length < 1 || name.length > MAX_NPM_NAME_LENGTH) {
    throw new PackageNameError('npm package name must be 1 to 214 characters');
  }
  const scoped = name.startsWith('@');
  const segments = (scoped ? name.slice(1) : name).split('/');
  const valid =
    segments.length === (scoped ? 2 : 1) &&
    segments.every((segment, index) => {
      const startsPlain = !segment.startsWith('.') && !segment.startsWith('_');
      const mayStartPlain = startsPlain || (legacyCase && scoped && index === 1);
      return (
        NPM_CHARACTERS.test(segment) && mayStartPlain && (legacyCase || !segment.includes('~'))
      );
    });
  if (!valid || NPM_RESERVED.has(name.toLowerCase())) {
    throw new PackageNameError('invalid npm package name');
  }
  if (!legacyCase && name !== name.toLowerCase()) {
    throw new PackageNameError('npm package name must not contain capitals');
  }
  return name.replace(CAPITAL, (c) => `!${c.toLowerCase()}`);
}

export function packageKey(name: string, options: PackageKeyOptions): string {
  if (options.ecosystem === 'composer') {
    return composerKey(name);
  }
  if (options.ecosystem === 'npm') {
    return npmKey(name, options.legacyCase === true);
  }
  throw new PackageNameError('unknown ecosystem');
}

export function displayName(key: string): string {
  const decoded = key.replace(ENCODED_CAPITAL, (_m, c: string) => c.toUpperCase());
  if (decoded.includes('!') || key !== key.toLowerCase()) {
    throw new PackageNameError('invalid package key');
  }
  return decoded;
}

export function searchableName(key: string): string {
  return key.replaceAll('!', '');
}
