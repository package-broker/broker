import {
  describePolicyDistFacts,
  describePolicyLookupFacts,
  describePolicyPageFacts,
} from './policy-facts.js';
import { openD1 } from './d1-open.js';

describePolicyPageFacts('D1', () => openD1(), false);
describePolicyLookupFacts('D1', () => openD1(), false);
describePolicyDistFacts('D1', () => openD1());
