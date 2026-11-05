import { describePolicyPageFacts } from './policy-facts.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

describePolicyPageFacts('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
