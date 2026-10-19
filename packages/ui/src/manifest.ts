export { UI_CONTENT_TYPES, parseUiManifest } from '@package-broker/core/platform/ui-manifest';
export type {
  UiContentType,
  UiManifestFile,
  UiManifest,
} from '@package-broker/core/platform/ui-manifest';

const BUDGET_GROWTH_PERCENT = 10;

export function findInlineCode(html: string): string[] {
  const found: string[] = [];
  if (/<script\b(?![^>]*(?<![\w-])src\s*=)[^>]*>/i.test(html)) found.push('inline script');
  if (/<style\b/i.test(html)) found.push('style element');
  if (/<[a-z][^>]*\sstyle\s*=/i.test(html)) found.push('style attribute');
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(html)) found.push('event handler attribute');
  if (/javascript:/i.test(html)) found.push('javascript URL');
  return found;
}

export function checkBudget(total: number, budget: number): { ok: boolean; limit: number } {
  const limit = Math.floor((budget * (100 + BUDGET_GROWTH_PERCENT)) / 100);
  return { ok: total <= limit, limit };
}
