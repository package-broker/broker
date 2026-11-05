import { auditCutoverRepositorySuite } from '../testing/audit-cutover-suite.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

auditCutoverRepositorySuite(() =>
  openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true }),
);
