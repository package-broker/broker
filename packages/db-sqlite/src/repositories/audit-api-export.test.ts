import { auditApiExportSuite } from '../testing/audit-api-export-suite.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

auditApiExportSuite(() => openMigratedDatabase({ twoOrganizations: true }));
