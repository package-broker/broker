import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as packageWriter from '../repositories/catalogue-write-package.js';

function targets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(targets);
}

it('keeps internal modules outside every package export target', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { exports: unknown };
  const exportedTargets = targets(manifest.exports);
  expect(exportedTargets.length).toBeGreaterThan(0);
  for (const target of exportedTargets) {
    const pattern = new RegExp(
      '^' +
        target
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*') +
        '$',
    );
    expect(target).not.toMatch(/(?:^|\/)internal(?:\/|$)/);
    expect(pattern.test('./dist/internal/catalogue-write-guard.js')).toBe(false);
    expect(pattern.test('./dist/internal/catalogue-write-guard.d.ts')).toBe(false);
  }
  expect(packageWriter).not.toHaveProperty('registerCatalogueWriteGuard');
  expect(packageWriter).not.toHaveProperty('assertCatalogueWriteGuard');
});
