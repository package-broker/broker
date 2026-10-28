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
): {
  initialGzipBytes: number;
  chunkGzipBytes: number;
  totalGzipBytes: number;
  initialFiles: string[];
} {
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
    initialFiles: [...initial],
    totalGzipBytes: fixedBytes + Object.values(gzipSizes).reduce((sum, bytes) => sum + bytes, 0),
    chunkGzipBytes: Math.max(
      0,
      ...Object.entries(gzipSizes)
        .filter(([path]) => !initial.has(path))
        .map(([, bytes]) => bytes),
    ),
  };
}

export function checkLoadBudgets(
  sizes: { initialGzipBytes: number; chunkGzipBytes: number; totalGzipBytes: number },
  budget: Record<string, unknown>,
) {
  const keys = ['initialGzipBytes', 'chunkGzipBytes', 'totalGzipBytes'] as const;
  for (const key of Object.keys(budget)) {
    if (!keys.some((known) => known === key)) throw new Error(`Unknown bundle budget key: ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(budget, key)) throw new Error(`Missing bundle budget key: ${key}`);
    if (
      !Number.isSafeInteger(budget[key]) ||
      (budget[key] as number) < (key === 'chunkGzipBytes' ? 0 : 1)
    ) {
      throw new Error(
        'Bundle budget values must be positive safe integers (chunkGzipBytes may be zero)',
      );
    }
  }
  return {
    initial: checkBudget(sizes.initialGzipBytes, budget.initialGzipBytes as number),
    chunk: checkBudget(sizes.chunkGzipBytes, budget.chunkGzipBytes as number),
    total: checkBudget(sizes.totalGzipBytes, budget.totalGzipBytes as number),
  };
}
