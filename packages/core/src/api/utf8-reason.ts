import * as z from 'zod';

export const UTF8_REASON_CHECK = z.refine<string>(
  (value) => new TextEncoder().encode(value).length <= 1000,
  'Reason exceeds 1000 bytes',
);
