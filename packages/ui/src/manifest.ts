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

interface OutputGraph {
  readonly [path: string]: { readonly imports: readonly { path: string; kind: string }[] };
}

export function measureInitialLoad(
  outputs: OutputGraph,
  entry: string,
  gzipSizes: Readonly<Record<string, number>>,
  fixedBytes: number,
): { initialGzipBytes: number; chunkGzipBytes: number } {
  const initial = new Set<string>();
  function visit(path: string) {
    if (initial.has(path)) return;
    initial.add(path);
    for (const imported of outputs[path]!.imports) {
      if (imported.kind !== 'dynamic-import') visit(imported.path);
    }
  }
  visit(entry);
  return {
    initialGzipBytes: fixedBytes + [...initial].reduce((sum, path) => sum + gzipSizes[path]!, 0),
    chunkGzipBytes: Math.max(
      0,
      ...Object.entries(gzipSizes)
        .filter(([path]) => !initial.has(path))
        .map(([, bytes]) => bytes),
    ),
  };
}

export function checkLoadBudgets(
  sizes: { initialGzipBytes: number; chunkGzipBytes: number },
  budget: { gzipBytes?: number; initialGzipBytes?: number; chunkGzipBytes?: number },
) {
  const initial = budget.initialGzipBytes ?? budget.gzipBytes;
  const chunk = budget.chunkGzipBytes ?? budget.gzipBytes;
  if (![initial, chunk].every((value) => Number.isSafeInteger(value) && value! > 0)) {
    throw new Error('Bundle budget values must be positive safe integers');
  }
  return {
    initial: checkBudget(sizes.initialGzipBytes, initial!),
    chunk: checkBudget(sizes.chunkGzipBytes, chunk!),
  };
}
