import { openD1 } from './d1-open.js';
import { describeDiscoveryRulesMigrationContract } from './discovery-rules-migration-contract.js';

describeDiscoveryRulesMigrationContract('D1', () => openD1({ migrated: false }));
