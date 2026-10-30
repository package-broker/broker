import { openMigratedDatabase } from '../testing/migrated-database.js';
import { auditExportRepositorySuite } from '../testing/audit-export-suite.js';

auditExportRepositorySuite(() => openMigratedDatabase({ twoOrganizations: true }));
