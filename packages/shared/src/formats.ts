/**
 * The formats of everything the pipeline writes for people: a new ticket, the plan, the PR description, review comments and Jira comments.
 * Each format is a markdown file in `guidelines/formats/<name>.md` that can be edited in the dashboard (Guidelines). The defaults below are
 * what a fresh install has and what is used when a file is missing or empty. A template holds `{{placeholder}}`s that code fills in; a
 * placeholder that is not known is left as written, so a typo shows up instead of vanishing.
 */

export interface FormatPlaceholder {
  name: string;
  meaning: string;
}

export interface FormatSpec {
  /** The file name without `.md`, in `guidelines/formats/`. */
  name: string;
  title: string;
  /** Where it is used. */
  description: string;
  /** `template`: code fills the placeholders. `instruction`: the text is handed to the agent (or the form) as written. */
  kind: 'template' | 'instruction';
  placeholders: FormatPlaceholder[];
  /** Placeholders the default needs to say something useful; the editor warns when one is gone. */
  required: string[];
  default: string;
}

export const FORMATS: readonly FormatSpec[] = [
  {
    name: 'ticket',
    title: 'Ticket',
    description: 'What a new ticket starts with in the "New ticket" form. Write what a good ticket looks like for your team.',
    kind: 'instruction',
    placeholders: [],
    required: [],
    default: `## Problem
What is wrong, or what is needed, and for whom?

## Expected behaviour
What should happen instead?

## Acceptance criteria
- [ ]

## Notes
Links, examples, constraints.
`,
  },
  {
    name: 'plan',
    title: 'Plan',
    description: 'The sections the planning agent writes in the plan (features and bugs). It follows this structure instead of its built-in one.',
    kind: 'instruction',
    placeholders: [],
    required: [],
    default: `## Goal
One sentence: what changes for whom.

## Current behaviour
2–4 bullets, each with \`file:line\`. (For bugs: the root cause, with the line that proves it.)

## Approach
What we will do and why. If options were weighed:
- **Option A** — trade-off
- **Option B** — trade-off
- **Chosen:** A, because …

## Changes
- \`path/to/file.ts\` — what changes

## Acceptance criteria
Testable checklist. Copy the ticket's criteria; add any that are implied.

## Out of scope
What this ticket does NOT do.
`,
  },
  {
    name: 'pr-description',
    title: 'Pull request description',
    description: 'The description of the pull request. Written when the draft opens and rewritten when the PR is marked ready.',
    kind: 'template',
    placeholders: [
      { name: 'title', meaning: 'the ticket title' },
      { name: 'key', meaning: 'the ticket key, for example SDA-12' },
      { name: 'key_link', meaning: 'the key, with a link to the Jira issue when there is one' },
      { name: 'problem', meaning: 'the ticket description, shortened' },
      { name: 'fix', meaning: 'one line per subtask, with its commit' },
      { name: 'test_plan', meaning: 'the acceptance criteria of each subtask' },
      { name: 'test_command', meaning: 'the targeted test command' },
      { name: 'review_notes', meaning: 'the findings still open after review, or "none"' },
    ],
    required: ['title', 'key_link'],
    default: `## Summary
{{title}} — {{key_link}}

## Problem
{{problem}}

## Fix implemented
{{fix}}

## Test plan
{{test_plan}}

Targeted test command: \`{{test_command}}\`

## Review notes
{{review_notes}}
`,
  },
  {
    name: 'review-comment',
    title: 'Review comment',
    description: 'The comment posted on the pull request after each review round.',
    kind: 'template',
    placeholders: [
      { name: 'round', meaning: 'the round number' },
      { name: 'summary', meaning: 'the reviewers’ summary' },
      { name: 'findings', meaning: 'one table per severity, or "No findings."' },
      { name: 'previous', meaning: 'how many earlier findings were fixed or are still open (round 2 and later; empty in round 1)' },
    ],
    required: ['findings'],
    default: `## Review — round {{round}}

{{summary}}

{{findings}}

{{previous}}
`,
  },
  {
    name: 'review-summary',
    title: 'Review summary',
    description: 'The comment posted on the pull request when it is marked ready for human review.',
    kind: 'template',
    placeholders: [
      { name: 'rounds', meaning: 'how many review rounds ran' },
      { name: 'fixed', meaning: 'how many findings were fixed' },
      { name: 'left', meaning: '"No findings remain open." or "Still open: 1 medium, 3 low."' },
    ],
    required: [],
    default: `## Review summary

{{rounds}} review round(s); {{fixed}} finding(s) fixed. {{left}}

CI checks passed; this PR is ready for human review.
`,
  },
  {
    name: 'jira-plan',
    title: 'Jira comment: the plan',
    description: 'The comment with the full plan, posted on the Jira issue when there is no Confluence page (or Confluence failed).',
    kind: 'template',
    placeholders: [
      { name: 'key', meaning: 'the ticket key' },
      { name: 'plan', meaning: 'the plan as markdown' },
    ],
    required: ['plan'],
    default: `## Plan for {{key}}

{{plan}}
`,
  },
  {
    name: 'jira-plan-link',
    title: 'Jira comment: the Confluence page',
    description: 'The comment that links the plan page in Confluence. It is edited in place as the page status changes.',
    kind: 'template',
    placeholders: [
      { name: 'key', meaning: 'the ticket key' },
      { name: 'url', meaning: 'the link to the Confluence page' },
      { name: 'status', meaning: 'the page status, for example "Draft, waiting for approval"' },
    ],
    required: ['url'],
    default: `The plan for {{key}} is in Confluence: {{url}}

Status: {{status}}
`,
  },
  {
    name: 'jira-needs-you',
    title: 'Jira comment: needs a person',
    description: 'The comment posted on the Jira issue when the pipeline needs a person (a blocking question, a hold, a CI problem).',
    kind: 'template',
    placeholders: [
      { name: 'title', meaning: 'what is needed, in a line' },
      { name: 'body', meaning: 'the details' },
    ],
    required: ['title'],
    default: `**Needs you:** {{title}}

{{body}}
`,
  },
];

export const formatSpec = (name: string): FormatSpec | undefined => FORMATS.find((f) => f.name === name);
export const FORMAT_DIR = 'formats';
/** The path of a format file, relative to the guidelines directory. */
export const formatPath = (name: string): string => `${FORMAT_DIR}/${name}.md`;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** The placeholders a template uses. */
export function placeholdersOf(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string))];
}

/** Which of a format's required placeholders a text no longer has (the editor warns about them). */
export function missingPlaceholders(name: string, template: string): string[] {
  const spec = formatSpec(name);
  if (!spec) return [];
  const used = placeholdersOf(template);
  return spec.required.filter((r) => !used.includes(r));
}

/**
 * Fills a template. Unknown placeholders stay as written; empty values leave no gap of blank lines; the result has no trailing whitespace
 * (the caller adds the final newline where one is wanted).
 */
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template
    .replace(PLACEHOLDER, (whole, name: string) => (name in values ? String(values[name]) : whole))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}
