import { auditNoneRepositorySuite } from '../testing/audit-none-suite.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

auditNoneRepositorySuite(() =>
  openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true }),
);
