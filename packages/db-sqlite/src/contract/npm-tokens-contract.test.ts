import { describeNpmTokensContract } from './npm-tokens-contract.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';
describeNpmTokensContract('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
