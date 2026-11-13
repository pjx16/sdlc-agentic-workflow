import { z } from 'zod';
import { TICKET_KINDS, type TicketKind } from './onboarding';

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
/** Strict: an unknown field (a typo such as `description` for `body`) is an error, not silently dropped. */
export const PasteTicketSchema = z.strictObject({
  projectId: z.string({ error: 'required' }).min(1, 'required'),
  title: z.string({ error: 'required' }).trim().min(1, 'required').max(200, 'must be at most 200 characters'),
  body: z.string().max(100_000, 'must be at most 100000 characters').default(''),
  type: z.enum(TICKET_TYPES, { error: 'must be one of story, bug, tech' }).optional(),
  /** What the ticket is. Takes the place of `type`; when only `type` is sent, the kind follows it. */
  kind: z.enum(TICKET_KINDS, { error: 'must be one of feature, bug, chore' }).optional(),
  featureKey,
});
export type PasteTicketInput = z.infer<typeof PasteTicketSchema>;

/** The old type and the new kind say the same thing in two vocabularies (story is a feature, tech is a chore). */
export const kindOfType = (type: TicketType): TicketKind => (type === 'bug' ? 'bug' : type === 'tech' ? 'chore' : 'feature');
export const typeOfKind = (kind: TicketKind): TicketType => (kind === 'bug' ? 'bug' : kind === 'chore' ? 'tech' : 'story');

/** Jira issue types map to ticket types (F3): "bug" is bug; "story" or "user story" is story; everything else is tech. */
export function mapJiraIssueType(name: string | null | undefined): TicketType {
  const n = (name ?? '').trim().toLowerCase();
  if (n === 'bug') return 'bug';
  if (n === 'story' || n === 'user story') return 'story';
  return 'tech';
}

/** A Jira key as accepted from MCP intake (F3): `^[A-Z][A-Z0-9]+-[0-9]+$`. */
export const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]+-[0-9]+$/;
