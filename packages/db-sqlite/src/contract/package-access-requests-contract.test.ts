import { describePackageAccessRequests } from './package-access-requests-contract.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';
describePackageAccessRequests('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
