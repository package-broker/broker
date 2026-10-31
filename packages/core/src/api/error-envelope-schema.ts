import * as z from 'zod';
import { VALIDATION_DETAIL_CODES } from './validate.js';
import { weakPasswordErrorResponse } from './auth-schemas.js';

export const errorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    problems: weakPasswordErrorResponse.shape.error.shape.problems.optional(),
    details: z
      .array(
        z.strictObject({
          path: z.string(),
          code: z.enum(VALIDATION_DETAIL_CODES),
          location: z.enum(['params', 'query', 'body']).optional(),
        }),
      )
      .max(20)
      .optional(),
  }),
});
