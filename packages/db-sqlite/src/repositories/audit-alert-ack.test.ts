import { it } from 'vitest';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import { auditAlertAcknowledgementContract } from '../testing/audit-alert-ack.js';

it('acknowledges and stages the control event atomically without a ledger row', async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true });
  try {
    await auditAlertAcknowledgementContract(database.executor, database.orgs!.a, database.orgs!.b);
  } finally {
    await database.close();
  }
});
