import { describeSourceSelectionContract } from './source-selection-contract.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import { describeSourceSelectionRacesContract } from './source-selection-races-contract.js';

describeSourceSelectionContract('node:sqlite', () =>
  openMigratedDatabase({ d1PatternLimit: true }),
);

describeSourceSelectionRacesContract('node:sqlite', () =>
  openMigratedDatabase({ d1PatternLimit: true }),
);
