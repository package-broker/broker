import { describeNpmLoginContract } from './npm-login-contract.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';
describeNpmLoginContract('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
