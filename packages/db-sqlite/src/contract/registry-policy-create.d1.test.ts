import { describeRegistryPolicyCreate } from './registry-policy-create.js';
import { openD1 } from './d1-open.js';

describeRegistryPolicyCreate('D1', () => openD1());
