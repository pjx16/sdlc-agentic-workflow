import type { StageName } from './enums';

/**
 * The agents (BUILD_PLAN v1 4.1): one job each. A prompt file per agent lives in `guidelines/stages/`, and each agent is also written to
 * `.claude/agents/` from it, so the two never drift. A stage key says which agent runs; the documentor serves two keys.
 */
export interface AgentSpec {
  /** The agent's name and the name of its prompt file (`guidelines/stages/<name>.md`). */
  name: string;
  /** The stage keys it runs as. */
  stages: readonly StageName[];
  /** One sentence: its one job. Used as the description of its `.claude/agents` file. */
  job: string;
  /** What the workspace is for this agent. */
  workspace: 'none' | 'read-only' | 'writes';
  model: 'haiku' | 'sonnet' | 'opus';
}

export const AGENTS: readonly AgentSpec[] = [
  { name: 'assistant', stages: ['assist'], job: 'Answer the developer’s questions about one support ticket and draft a response.', workspace: 'read-only', model: 'sonnet' },
  { name: 'repo-profiler', stages: ['repoProfile'], job: 'Propose the stack, the install, typecheck and test commands, the KB folder and the test-file pattern of a repository.', workspace: 'read-only', model: 'sonnet' },
  { name: 'onboarding-advisor', stages: ['onboardAdvise'], job: 'Propose the Jira status mapping, approval statuses, issue-type routing, intake label and Confluence space for a project.', workspace: 'none', model: 'haiku' },
  { name: 'feature-mapper', stages: ['featureMap'], job: 'Match a ticket to an existing knowledge-base feature key, or say it is new.', workspace: 'read-only', model: 'haiku' },
  { name: 'documentor', stages: ['kbBuild', 'kbUpdate'], job: 'Create or refresh one feature doc in the knowledge base.', workspace: 'writes', model: 'sonnet' },
  { name: 'solution-architect', stages: ['solutionDesign'], job: 'Design a feature: goal, approach, acceptance criteria and what is out of scope.', workspace: 'read-only', model: 'opus' },
  { name: 'bug-investigator', stages: ['bugInvestigation'], job: 'Find the root cause of a bug with file and line evidence, and write the acceptance criteria for the fix.', workspace: 'read-only', model: 'opus' },
  { name: 'technical-architect', stages: ['technicalDesign'], job: 'Turn an approved plan into files, an order of work and subtasks with acceptance criteria.', workspace: 'read-only', model: 'sonnet' },
  { name: 'test-writer', stages: ['tests'], job: 'Write failing tests for one subtask.', workspace: 'writes', model: 'sonnet' },
  { name: 'coder', stages: ['implement'], job: 'Make one subtask’s tests pass with the smallest correct change.', workspace: 'writes', model: 'sonnet' },
  { name: 'fixer', stages: ['fix'], job: 'Remove one named failure: failing tests, review findings or a CI failure.', workspace: 'writes', model: 'sonnet' },
  { name: 'pr-reviewer', stages: ['prReview'], job: 'Review a diff for correctness, and whether every acceptance criterion is met and tested.', workspace: 'read-only', model: 'sonnet' },
  { name: 'quality-reviewer', stages: ['qualityReview'], job: 'Review a diff for readability and the repository’s standards.', workspace: 'read-only', model: 'haiku' },
  { name: 'security-reviewer', stages: ['securityReview'], job: 'Review a diff for security problems only.', workspace: 'read-only', model: 'sonnet' },
  { name: 'orchestrator', stages: ['orchestrate'], job: 'Choose one of the legal moves for a ticket at a decision point, and say why.', workspace: 'none', model: 'haiku' },
  { name: 'ci-triager', stages: ['ciTriage'], job: 'Classify a failed CI run as a code problem, a flaky test or an infrastructure problem.', workspace: 'none', model: 'haiku' },
];

/** The prompt file (without `.md`) of a stage: the agent that runs it. */
export function promptFileOf(stage: StageName): string {
  const agent = AGENTS.find((a) => a.stages.includes(stage));
  if (!agent) throw new Error(`No agent runs the stage "${stage}"`);
  return agent.name;
}

const TOOLS: Record<AgentSpec['workspace'], string> = { none: 'Read', 'read-only': 'Read, Grep, Glob, Bash', writes: 'Read, Grep, Glob, Bash, Edit, Write' };

/** A `.claude/agents/sdlc-<name>.md` file, generated from the agent's prompt (BUILD_PLAN v1 6.9). */
export function renderAgentFile(agent: AgentSpec, prompt: string): string {
  return [
    '---',
    `name: sdlc-${agent.name}`,
    `description: SDLC agent: ${agent.job}`,
    `tools: ${TOOLS[agent.workspace]}`,
    `model: ${agent.model}`,
    '---',
    '',
    'Follow the shared pipeline rules in `guidelines/default-CLAUDE.md` (if present in this repo) and the stack guideline in `guidelines/stacks/` that matches the project.',
    '',
    prompt.trimEnd(),
    '',
  ].join('\n');
}
