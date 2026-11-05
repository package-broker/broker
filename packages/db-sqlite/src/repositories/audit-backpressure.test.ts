import { auditBackpressureSuite } from '../testing/audit-backpressure-suite.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

auditBackpressureSuite(() =>
  openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true }),
);
