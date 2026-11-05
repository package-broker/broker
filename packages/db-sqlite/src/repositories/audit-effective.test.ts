import { openMigratedDatabase } from '../testing/migrated-database.js';
import { auditEffectiveRepositorySuite } from '../testing/audit-effective-suite.js';
auditEffectiveRepositorySuite(() =>
  openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true }),
);
