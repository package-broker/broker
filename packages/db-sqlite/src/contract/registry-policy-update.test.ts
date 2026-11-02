import { describeRegistryPolicyUpdate } from './registry-policy-update.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

describeRegistryPolicyUpdate('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
