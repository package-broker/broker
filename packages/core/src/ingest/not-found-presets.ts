import type { CatalogueSourceType } from '../db/catalogue.js';

export const COMPOSER_REPOSITORY_NOT_FOUND_SHAPES: readonly string[] = Object.freeze([
  '{"packages":[]}',
]);
export const PACKAGIST_PROXY_NOT_FOUND_SHAPES: readonly string[] = Object.freeze([
  '{"packages":[]}',
]);
export const NPMJS_PROXY_NOT_FOUND_SHAPES: readonly string[] = Object.freeze([
  '{"error":"Not found"}',
]);
/** A configurable npm endpoint has no universal, authoritative not-found body. */
export const NPM_REGISTRY_NOT_FOUND_SHAPES: readonly string[] = Object.freeze([]);

export const NOT_FOUND_PRESETS = Object.freeze({
  composer_repository: COMPOSER_REPOSITORY_NOT_FOUND_SHAPES,
  packagist_proxy: PACKAGIST_PROXY_NOT_FOUND_SHAPES,
  npmjs_proxy: NPMJS_PROXY_NOT_FOUND_SHAPES,
  npm_registry: NPM_REGISTRY_NOT_FOUND_SHAPES,
} satisfies Partial<Record<CatalogueSourceType, readonly string[]>>);

export function isRegistryNotFound(sourceType: string, body: unknown): boolean {
  if (!Object.hasOwn(NOT_FOUND_PRESETS, sourceType)) return false;
  const shapes = NOT_FOUND_PRESETS[sourceType as keyof typeof NOT_FOUND_PRESETS];
  return shapes.includes(JSON.stringify(body));
}
