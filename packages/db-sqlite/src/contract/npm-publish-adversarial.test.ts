import { describeNpmPublishAdversarial } from './npm-publish-adversarial.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';

describeNpmPublishAdversarial('node:sqlite', () => openMigratedDatabase({ d1PatternLimit: true }));
