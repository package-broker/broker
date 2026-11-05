import { describeRegistryPolicyUpdate } from './registry-policy-update.js';
import { openD1 } from './d1-open.js';

describeRegistryPolicyUpdate('D1', () => openD1());
