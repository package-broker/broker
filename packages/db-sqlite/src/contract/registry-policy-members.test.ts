import { describeRegistryPolicyMembers } from './registry-policy-members.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

describeRegistryPolicyMembers('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
