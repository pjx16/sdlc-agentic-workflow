import { z } from 'zod';

export const TICKET_TYPES = ['story', 'bug', 'tech'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

/** Feature keys name KB docs: lower-case letters, digits, dot, dash and underscore. */
const featureKey = z
  .string()
  .trim()
  .max(64, 'must be at most 64 characters')
  .refine((v) => v === '' || /^[a-z0-9][a-z0-9._-]*$/.test(v), 'use lower-case letters, digits, dot, dash or underscore')
  .optional()
  .transform((v) => (v === '' ? undefined : v));

/** Body of POST /tickets (BUILD_PLAN 8 Tickets, paste). */
export const PasteTicketSchema = z.object({
  projectId: z.string({ error: 'required' }).min(1, 'required'),
  title: z.string({ error: 'required' }).trim().min(1, 'required').max(200, 'must be at most 200 characters'),
  body: z.string().max(100_000, 'must be at most 100000 characters').default(''),
  type: z.enum(TICKET_TYPES, { error: 'must be one of story, bug, tech' }).default('story'),
  featureKey,
});
export type PasteTicketInput = z.infer<typeof PasteTicketSchema>;

/** Jira issue types map to ticket types (F3): "bug" is bug; "story" or "user story" is story; everything else is tech. */
export function mapJiraIssueType(name: string | null | undefined): TicketType {
  const n = (name ?? '').trim().toLowerCase();
  if (n === 'bug') return 'bug';
  if (n === 'story' || n === 'user story') return 'story';
  return 'tech';
}

/** A Jira key as accepted from MCP intake (F3): `^[A-Z][A-Z0-9]+-[0-9]+$`. */
export const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]+-[0-9]+$/;
