import { openMigratedDatabase } from '../testing/migrated-database.js';
import { auditForkRepositorySuite } from '../testing/audit-fork-suite.js';

await auditForkRepositorySuite(() =>
  openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true }),
);
