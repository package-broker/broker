import { describeRegistryPolicyExpiry } from './registry-policy-expiry.js';
import { openD1 } from './d1-open.js';

describeRegistryPolicyExpiry('D1', () => openD1());
