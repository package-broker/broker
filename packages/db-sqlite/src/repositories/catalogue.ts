import type { CatalogueReader } from '@package-broker/core/db/catalogue';
import type { ScalarSqlExecutor } from '@package-broker/core/db/port';
import { createVersionReader } from './catalogue-read.js';
import { createDistResolver } from './catalogue-dist.js';
import { createCatalogueList } from './catalogue-list.js';
import { createCatalogueLookup } from './catalogue-lookup.js';
import { createClosureEdges } from './closure-edges.js';
import { createProxyAdmission } from './proxy-admission.js';

export function createCatalogueReader(executor: ScalarSqlExecutor): CatalogueReader {
  return {
    ...createVersionReader(executor),
    ...createCatalogueLookup(executor),
    ...createCatalogueList(executor),
    ...createDistResolver(executor),
    ...createProxyAdmission(executor),
    ...createClosureEdges(executor),
  };
}
