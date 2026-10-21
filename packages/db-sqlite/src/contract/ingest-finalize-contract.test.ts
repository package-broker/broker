import { describeIngestFinalizeContract } from './ingest-finalize-contract.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

describeIngestFinalizeContract('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
