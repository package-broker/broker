import { describePolicyMigrationContract } from './policy-migration.js';
import { openD1 } from './d1-open.js';

describePolicyMigrationContract('D1', () => openD1({ migrated: false }));
