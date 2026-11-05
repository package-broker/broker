import { describePolicyLookupFacts } from './policy-facts.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

describePolicyLookupFacts('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
