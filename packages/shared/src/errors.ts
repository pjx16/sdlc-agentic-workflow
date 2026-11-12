import { z } from 'zod';

/** Error body used by every API endpoint (BUILD_PLAN §8). */
export const ErrorBodySchema = z.object({
  error: z.string(),
  message: z.string(),
  fields: z.record(z.string(), z.string()).optional(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export const ErrorCodes = {
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  setupRequired: 'setup_required',
  tooManyRequests: 'too_many_requests',
  validation: 'validation_error',
  notFound: 'not_found',
  conflict: 'conflict',
  invalidTransition: 'invalid_transition',
  jiraError: 'jira_error',
  internal: 'internal_error',
} as const;
