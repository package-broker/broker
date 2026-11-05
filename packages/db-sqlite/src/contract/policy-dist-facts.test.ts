import { describePolicyDistFacts } from './policy-facts.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

describePolicyDistFacts('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
