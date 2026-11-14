import { z } from 'zod';
import { PROJECT_STACKS, TICKET_STATUSES, type TicketStatus } from './enums';

/** Project onboarding (BUILD_PLAN v1 6.7): code collects facts, two agents propose, the person confirms. */

export const ONBOARDING_STATUSES = ['draft', 'profiling', 'proposed', 'confirmed'] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

/** What a ticket of an issue type becomes. `ignore` types are not picked up. */
export const ISSUE_KINDS = ['feature', 'bug', 'chore', 'ignore'] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];
/** What a pipeline ticket is (BUILD_PLAN v1 6.9). */
export const TICKET_KINDS = ['feature', 'bug', 'chore'] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

export const PLANS_PARENT_PAGE_TITLE = 'sdlc-agent plans';

// ------------------------------------------------------------------------------------------------ agent output

const text = z.string().min(1, 'must not be empty');

/** `repo-profiler`: stack, commands, KB folder and the test-file pattern. */
export const RepoProfileData = z.object({
  stack: z.enum(PROJECT_STACKS),
  installCmd: z.string(),
  typecheckCmd: z.string(),
  testCmdTemplate: text.refine((v) => v.includes('{files}'), 'must contain {files}'),
  kbDir: text.refine((v) => !v.startsWith('/') && !v.split('/').includes('..'), 'must be a relative path inside the repository'),
  testFilePattern: z.string(),
  exampleTestFile: z.string().nullable(),
});
export type RepoProfile = z.infer<typeof RepoProfileData>;

const statusMapShape = Object.fromEntries(TICKET_STATUSES.map((s) => [s, z.string().min(1).nullable()])) as Record<TicketStatus, z.ZodNullable<z.ZodString>>;

/** `onboarding-advisor`: how Jira maps onto the pipeline. */
export const OnboardAdviseData = z.object({
  /** Each internal state to one Jira status, or none. Several states may share a status. */
  statusMap: z.object(statusMapShape).partial().transform((m) => m as Partial<Record<TicketStatus, string | null>>),
  approvalStatuses: z.object({ plan: z.string().min(1).nullable(), breakdown: z.string().min(1).nullable() }),
  issueTypeRouting: z.record(z.string(), z.enum(ISSUE_KINDS)),
  intakeLabel: z.string().trim().min(1).regex(/^[^\s]+$/, 'must not contain spaces'),
  confluenceSpaceKey: z.string().nullable(),
});
export type OnboardAdvice = z.infer<typeof OnboardAdviseData>;

// ------------------------------------------------------------------------------------------------ facts

export interface JiraFacts {
  projectName: string;
  issueTypes: { name: string; subtask: boolean }[];
  /** Statuses of each issue type, with their category (new, indeterminate, done). */
  statusesByType: { type: string; statuses: { name: string; category: string }[] }[];
  /** Labels in use on recent issues (Jira has no per-project label endpoint). */
  labels: string[];
}
export interface GithubFacts {
  defaultBranch: string;
  languages: string[];
}
export interface ConfluenceSpace {
  key: string;
  name: string;
}
export interface OnboardingFacts {
  github: GithubFacts;
  jira: JiraFacts | null;
  /** Spaces the person can write to, or null with the reason when Confluence cannot be reached. */
  confluence: { spaces: ConfluenceSpace[] } | { spaces: null; reason: string };
}

export interface CommandCheck {
  command: string;
  ok: boolean;
  /** The last lines of the output, for the review card. */
  tail: string;
}

// ------------------------------------------------------------------------------------------------ the proposal

export const ONBOARDING_SECTIONS = ['commands', 'statusMap', 'routing', 'label', 'confluence'] as const;
export type OnboardingSection = (typeof ONBOARDING_SECTIONS)[number];
/** These two change what the pipeline does to Jira, so they must be accepted explicitly. */
export const MUST_ACCEPT: readonly OnboardingSection[] = ['statusMap', 'label'];

export interface OnboardingProposal {
  facts: OnboardingFacts;
  profile: RepoProfile & { baseBranch: string; installCheck: CommandCheck | null; typecheckCheck: CommandCheck | null };
  advice: OnboardAdvice;
  /** Which sections the person accepted (or edited, which counts as accepting). */
  accepted: Partial<Record<OnboardingSection, boolean>>;
  createdAt: string;
}

export const DEFAULT_ROUTING_KINDS: Record<string, IssueKind> = {
  story: 'feature', 'user story': 'feature', feature: 'feature', improvement: 'feature', task: 'feature', bug: 'bug', defect: 'bug', chore: 'chore', 'technical task': 'chore', 'tech debt': 'chore', epic: 'ignore', 'sub-task': 'ignore', subtask: 'ignore',
};

/** The routing code falls back on when the advisor gave none for a type. Sub-task and Epic types default to `ignore`. */
export function defaultRouting(issueTypes: { name: string; subtask: boolean }[]): Record<string, IssueKind> {
  return Object.fromEntries(issueTypes.map((t) => [t.name, t.subtask ? 'ignore' : (DEFAULT_ROUTING_KINDS[t.name.trim().toLowerCase()] ?? 'feature')]));
}

/** The intake query: the label, and only the issue types that route to a kind (BUILD_PLAN v1 6.7). Editable under Advanced. */
export function buildIntakeJql(a: { projectKey: string; label: string; routing: Record<string, IssueKind> }): string {
  const types = Object.entries(a.routing)
    .filter(([, kind]) => kind !== 'ignore')
    // Sorted: the proposal is stored as jsonb, which does not keep key order, and the query must not depend on it.
    .map(([name]) => `"${name.replace(/"/g, '')}"`)
    .sort((x, y) => x.localeCompare(y));
  const typePart = types.length > 0 ? ` AND issuetype in (${types.join(', ')})` : '';
  return `project = "${a.projectKey}" AND labels = "${a.label.replace(/"/g, '')}"${typePart} ORDER BY created ASC`;
}

/** The kind of a Jira issue by the project's routing; falls back on the issue type's own name. */
export function kindForIssueType(routing: Record<string, IssueKind> | undefined, issueType: string | null | undefined, fallback: TicketKind): TicketKind | 'ignore' {
  const name = (issueType ?? '').trim();
  const hit = routing && Object.entries(routing).find(([k]) => k.trim().toLowerCase() === name.toLowerCase());
  return hit ? hit[1] : fallback;
}

/** Whether a section needs a person's decision before the project can be confirmed. */
export function missingAcceptance(accepted: OnboardingProposal['accepted']): OnboardingSection[] {
  return MUST_ACCEPT.filter((s) => !accepted[s]);
}
