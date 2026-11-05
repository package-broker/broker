import { describeRegistryPolicyMembers } from './registry-policy-members.js';
import { openD1 } from './d1-open.js';

describeRegistryPolicyMembers('D1', () => openD1());
