import { describeTrustedPublishers } from './trusted-publishers-contract.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';
describeTrustedPublishers('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
