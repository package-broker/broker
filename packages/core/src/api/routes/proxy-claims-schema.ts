import * as z from 'zod';
import { errorEnvelopeSchema } from '../error-envelope-schema.js';

export const proxyClaimConflict = errorEnvelopeSchema.extend({
  conflictingClaims: z.array(z.string()).optional(),
});
