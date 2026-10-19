import type { Platform } from './plugin.js';

/** Inert selection; only the builder imports the provider package. */
export interface AssetDeclaration {
  readonly kind: 'ui';
  readonly provider: string;
}

export interface AssetProviderContextV1 {
  readonly target: Platform;
}

export interface AssetProviderResultV1 {
  /** Local file: URL of a version-1 UI manifest; assets are adjacent files. */
  readonly manifestUrl: string;
}

/** Build-only port. Providers must never be imported into a runtime bundle. */
export interface AssetProviderV1 {
  readonly apiVersion: 1;
  resolve(context: AssetProviderContextV1): Promise<AssetProviderResultV1>;
}

export function defineAssets<const T extends AssetDeclaration>(
  declaration: T & Record<Exclude<keyof T, keyof AssetDeclaration>, never>,
): T {
  return declaration;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assetDeclarationProblems(value: unknown): string[] {
  if (!isRecord(value)) return ['assets: declaration must be an object'];
  const problems: string[] = [];
  if (Object.keys(value).some((key) => key !== 'kind' && key !== 'provider')) {
    problems.push('assets: declaration contains an unknown key');
  }
  if (value.kind !== 'ui') problems.push('assets: unsupported kind');
  if (
    typeof value.provider !== 'string' ||
    !/^(?:@[a-z0-9_-]+\/)?[a-z0-9_-][a-z0-9._-]*(?:\/[a-z0-9_-][a-z0-9._-]*)*$/.test(
      value.provider,
    ) ||
    value.provider.includes('..')
  ) {
    problems.push('assets: provider must be a package specifier');
  }
  return problems;
}

export function assetProviderProblems(value: unknown): string[] {
  if (!isRecord(value)) return ['assets: provider must be an object'];
  const problems: string[] = [];
  if (value.apiVersion !== 1) problems.push('assets: unsupported provider apiVersion');
  if (typeof value.resolve !== 'function')
    problems.push('assets: provider resolve must be a function');
  return problems;
}

export function assetProviderResultProblems(value: unknown): string[] {
  const problem = ['assets: provider manifestUrl must be a local file URL'];
  if (!isRecord(value) || typeof value.manifestUrl !== 'string') return problem;
  try {
    const url = new URL(value.manifestUrl);
    if (
      url.protocol !== 'file:' ||
      url.hostname !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.pathname.endsWith('/')
    ) {
      return problem;
    }
  } catch {
    return problem;
  }
  return [];
}
