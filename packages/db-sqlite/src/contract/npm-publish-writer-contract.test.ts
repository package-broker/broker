import { describeNpmPublishWriterContract } from './npm-publish-writer-contract.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

describeNpmPublishWriterContract('node:sqlite', () =>
  openMigratedDatabase({ d1PatternLimit: true }),
);
