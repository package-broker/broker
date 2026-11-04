import { openMigratedDatabase } from '../testing/migrated-database.js';
import { describeDiscoveryRulesContract } from './discovery-rules-contract.js';
describeDiscoveryRulesContract('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
