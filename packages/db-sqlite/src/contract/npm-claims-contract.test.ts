import { describeNpmClaimsContract } from './npm-claims-contract.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';
describeNpmClaimsContract('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
