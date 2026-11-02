import { describeRegistryPolicyExpiry } from './registry-policy-expiry.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

describeRegistryPolicyExpiry('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
