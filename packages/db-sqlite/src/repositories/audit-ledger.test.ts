import { openMigratedDatabase } from '../testing/migrated-database.js';
import { auditLedgerRepositorySuite } from '../testing/audit-ledger-suite.js';

auditLedgerRepositorySuite(() => openMigratedDatabase({ twoOrganizations: true }));
