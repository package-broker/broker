import * as z from 'zod';
import { PROJECT_SLUG_PATTERN } from '../../authz/project-path.js';

export const myPermissionsResponse = z.strictObject({ organization: z.array(z.string()) });
export const myProjectPermissionsResponse = z.strictObject({ project: z.array(z.string()) });
export const projectPermissionsParams = z.strictObject({
  project: z.string().regex(PROJECT_SLUG_PATTERN),
});
