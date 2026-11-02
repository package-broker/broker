import { describeRegistryPolicyCreate } from './registry-policy-create.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

describeRegistryPolicyCreate('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
