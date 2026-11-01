import { describePackageDetail } from './package-detail-contract.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';
describePackageDetail('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
