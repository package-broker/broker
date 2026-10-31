import { describeBlobSupersededContract } from './blob-superseded-contract.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

describeBlobSupersededContract('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
