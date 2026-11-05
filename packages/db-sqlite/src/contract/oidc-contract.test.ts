import { describeOidcContract } from './oidc-contract.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';
describeOidcContract('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
