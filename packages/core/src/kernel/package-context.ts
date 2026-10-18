import type { PackageVisibility } from '../db/catalogue.js';
import type { RequestContext } from '../plugin.js';

type ResolvedPackage = Exclude<PackageVisibility, { readonly kind: 'absent' }>;
const packages = new WeakMap<RequestContext, ResolvedPackage>();

export function setResolvedPackage(ctx: RequestContext, outcome: ResolvedPackage): void {
  if (packages.has(ctx)) throw new TypeError('resolved package is already set');
  packages.set(ctx, outcome);
}

export function resolvedPackageOf(ctx: RequestContext): ResolvedPackage | null {
  return packages.get(ctx) ?? null;
}
