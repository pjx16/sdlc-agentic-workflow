import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ClaudeMdMode, ProjectStack, StageName } from '@sdlc/shared';
import { CLAUDE_MD_FILES, buildStageJson, hidesRepoClaudeMd, includesOurClaudeMd, isJiraStage, type StageConfigInput, type StageJson } from './stage-config';

export interface TicketInfo {
  key: string;
  title: string;
  body: string;
}

export interface SubtaskInfo {
  seq: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  files: string[];
  dependsOn: number[];
}

export interface FindingInfo {
  id: string;
  severity: string;
  file: string;
  line: number | null;
  issue: string;
  rule: string;
  fix: string;
}

/** Everything a stage may need. Each stage uses the subset listed in BUILD_PLAN 6.4. */
export interface StageInputs {
  ticket?: TicketInfo;
  kbDoc?: string;
  indexKeys?: string[];
  plan?: string;
  subtask?: SubtaskInfo;
  testFiles?: string[];
  exampleTestFile?: string;
  /** Verify tail, open critical/high findings, or CI log tail, for `fix`. */
  failureOutput?: string;
  acceptanceCriteria?: string[];
  diff?: string;
  reviewChecklist?: string;
  previousFindings?: FindingInfo[];
  existingDoc?: string;
  docTemplate?: string;
  jql?: string;
  projectKey?: string;
  ticketSchema?: string;
  syncPayload?: string;
}

export interface BuildContextInput {
  stageRunId: string;
  stage: StageName;
  stack: ProjectStack;
  claudeMdMode: ClaudeMdMode;
  inputs: StageInputs;
  /** JSON Schema of the stage envelope (written to schema.json). */
  schema: object;
  config: StageConfigInput;
  /** Where the worker keeps run directories, and where the guideline files live. */
  runsDir: string;
  guidelinesDir: string;
  /** The workspace, for the CLAUDE.md hide-mount decision. */
  workspacePath?: string;
  /** Contents of the Jira MCP config file (Jira stages in MCP mode). */
  mcpConfigJson?: string;
}

export interface BuiltContext {
  runDir: string;
  stageJson: StageJson;
  /** Files to hide in /workspace with an empty bind mount (mode `ours`, only those that exist). */
  hideFiles: string[];
  files: string[];
}

const STACK_FILE: Record<ProjectStack, string> = { ts_node: 'ts-node.md', nestjs: 'nestjs.md', nextjs: 'nextjs.md' };

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** What each stage's `data` object must contain (BUILD_PLAN 6.5), as plain text for the prompt. */
const DATA_SHAPES: Record<StageName, string> = {
  kbBuild: '{ featureKey, isNew, docPath, globs[] }. If isNew is false, featureKey must be a key already in the index.',
  plan: '{ planMarkdown, risks[], openQuestions[] }',
  breakdown: '{ subtasks: [{ seq, title, description, acceptanceCriteria[], files[], dependsOn[] }] }',
  tests: '{ testFiles[], criteriaCovered: [{ criterion, test }] }',
  implement: '{ filesChanged[] }',
  fix: '{ filesChanged[] }',
  review: '{ findings: [{ severity, file, line (nullable), issue, rule, fix }], previousFindings: [{ id, status: "fixed" | "still_open" }] }',
  kbUpdate: '{ featureKey, docPath, changed }',
  jiraIntake: '{ tickets: [{ key, summary, description, issuetype, labels[], priority }] }',
  jiraSync: '{ applied, detail }',
};

interface Section {
  heading: string;
  body: string;
}

const fenced = (text: string) => `\`\`\`\n${text}\n\`\`\``;
const list = (items: readonly string[]) => (items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : '_none_');

function subtaskText(s: SubtaskInfo): string {
  return [
    `Subtask ${s.seq}: ${s.title}`,
    '',
    s.description,
    '',
    'Acceptance criteria:',
    list(s.acceptanceCriteria),
    '',
    'Files:',
    list(s.files),
    '',
    `Depends on: ${s.dependsOn.length > 0 ? s.dependsOn.join(', ') : 'nothing'}`,
  ].join('\n');
}

function findingsText(findings: FindingInfo[]): string {
  return findings.map((f) => `- [${f.id}] ${f.severity} ${f.file}${f.line === null ? '' : `:${f.line}`}: ${f.issue} (rule: ${f.rule}; fix: ${f.fix})`).join('\n');
}

/** Context files written next to the prompt, referenced by path (they can be large). */
interface ContextFile {
  name: string;
  content: string;
}

interface Plan {
  sections: Section[];
  files: ContextFile[];
}

const NO_KB = '_No knowledge-base document exists for this feature yet._';

/** The sections of one stage's prompt, in the order of the BUILD_PLAN 6.4 table. */
function planSections(stage: StageName, i: StageInputs): Plan {
  const files: ContextFile[] = [];
  const sections: Section[] = [];
  const ticketFull = (): Section => {
    const t = i.ticket;
    files.push({ name: 'ticket.md', content: t ? `# ${t.key}: ${t.title}\n\n${t.body}\n` : '' });
    return { heading: 'Ticket', body: t ? `${t.key}: ${t.title}\n\nThe full ticket is in /context/ticket.md.` : '_No ticket._' };
  };
  /** Title plus the first paragraph of the body (at most 400 characters), inline. */
  const ticketSummary = (): Section => {
    const t = i.ticket;
    if (!t) return { heading: 'Ticket', body: '_No ticket._' };
    const firstParagraph = (t.body.split(/\n\s*\n/)[0] ?? '').trim();
    const summary = firstParagraph.length > 400 ? `${firstParagraph.slice(0, 397)}...` : firstParagraph;
    return { heading: 'Ticket', body: `${t.key}: ${t.title}${summary ? `\n\n${summary}` : ''}` };
  };
  const kb = (): Section => {
    if (i.kbDoc) files.push({ name: 'kb.md', content: i.kbDoc });
    return { heading: 'KB doc', body: i.kbDoc ? 'The knowledge-base document is in /context/kb.md.' : NO_KB };
  };
  const diff = (): Section => {
    files.push({ name: 'diff.patch', content: i.diff ?? '' });
    return { heading: 'Diff', body: 'The change under review is in /context/diff.patch.' };
  };

  switch (stage) {
    case 'kbBuild':
      sections.push(ticketFull(), { heading: 'Index keys', body: list(i.indexKeys ?? []) });
      break;
    case 'plan':
      sections.push(ticketFull(), kb());
      break;
    case 'breakdown':
      sections.push(ticketFull(), { heading: 'Approved plan', body: i.plan ?? '_No plan._' }, kb());
      break;
    case 'tests':
      sections.push(ticketSummary(), { heading: 'Approved plan', body: i.plan ?? '_No plan._' }, { heading: 'Subtask', body: i.subtask ? subtaskText(i.subtask) : '_No subtask._' }, kb(), {
        heading: 'Example test file',
        body: i.exampleTestFile ?? '_No example test file found._',
      });
      break;
    case 'implement':
      sections.push(ticketSummary(), { heading: 'Plan', body: i.plan ?? '_No plan._' }, { heading: 'Subtask', body: i.subtask ? subtaskText(i.subtask) : '_No subtask._' }, kb(), {
        heading: 'Test files',
        body: list(i.testFiles ?? []),
      });
      break;
    case 'fix':
      sections.push({ heading: 'Failure output', body: fenced(i.failureOutput ?? '') });
      if (i.subtask) sections.push({ heading: 'Subtask', body: subtaskText(i.subtask) });
      break;
    case 'review':
      sections.push({ heading: 'Acceptance criteria', body: list(i.acceptanceCriteria ?? []) }, diff(), { heading: 'Review checklist', body: i.reviewChecklist ?? '_No checklist._' });
      if (i.previousFindings && i.previousFindings.length > 0) sections.push({ heading: 'Previous findings', body: findingsText(i.previousFindings) });
      break;
    case 'kbUpdate':
      sections.push(diff(), { heading: 'Existing doc', body: i.existingDoc ? fenced(i.existingDoc) : NO_KB }, { heading: 'Doc template', body: i.docTemplate ?? '_No template._' });
      break;
    case 'jiraIntake':
      sections.push({ heading: 'JQL', body: i.jql ?? '' }, { heading: 'Project key', body: i.projectKey ?? '' }, { heading: 'Ticket schema', body: i.ticketSchema ?? '' });
      break;
    case 'jiraSync':
      sections.push({ heading: 'Operation', body: fenced(i.syncPayload ?? '') });
      break;
  }
  return { sections, files };
}

async function readIfExists(file: string): Promise<string | null> {
  return existsSync(file) ? (await readFile(file, 'utf8')).trim() : null;
}

/** `system.md`: the stack guideline, plus our default CLAUDE.md in modes ours and both (BUILD_PLAN 6.4). */
export async function buildSystemMd(guidelinesDir: string, stack: ProjectStack, mode: ClaudeMdMode): Promise<string> {
  const parts: string[] = [];
  const stackGuideline = await readIfExists(path.join(guidelinesDir, 'stacks', STACK_FILE[stack]));
  if (stackGuideline) parts.push(`# Stack guideline\n\n${stackGuideline}`);
  if (includesOurClaudeMd(mode)) {
    const ours = await readIfExists(path.join(guidelinesDir, 'default-CLAUDE.md'));
    if (ours) parts.push(`# Project instructions\n\n${ours}`);
  }
  return parts.join('\n\n');
}

export function buildPromptMd(args: { stage: StageName; sections: Section[]; instructions: string | null; attempt: number; stack: string; stackGuideline?: string | null }): string {
  const out: string[] = [`<!-- stage: ${args.stage} -->`];
  if (args.instructions) out.push(`## Instructions\n\n${args.instructions}`);
  if (args.attempt > 1) {
    out.push(`## Attempt ${args.attempt}\n\nThis is a retry. The workspace may already hold partial changes from the previous attempt; inspect it before you start.`);
  }
  for (const s of args.sections) out.push(`## ${s.heading}\n\n${s.body}`);
  if (args.stage === 'kbBuild' && args.stackGuideline) out.push(`## Stack guideline\n\n${args.stackGuideline}`);
  out.push(
    [
      '## Output',
      '',
      'Reply only with the structured result. Use `status: "done"` when finished, `"needs_input"` with a `question` if you cannot continue without an answer, or `"blocked"` if you cannot proceed and no question would help. `summary` is at most 400 characters.',
      '',
      `\`data\` for this stage: ${DATA_SHAPES[args.stage]}`,
    ].join('\n'),
  );
  return `${out.join('\n\n')}\n`;
}

/** Writes DATA_DIR/runs/<stageRunId>/ and returns the hide-mount decision (BUILD_PLAN 6.4). */
export async function buildStageContext(input: BuildContextInput): Promise<BuiltContext> {
  const runDir = path.join(input.runsDir, input.stageRunId);
  await mkdir(runDir, { recursive: true });

  const attempt = input.config.attempt ?? 1;
  const stageJson = buildStageJson(input.config);
  const instructions = await readIfExists(path.join(input.guidelinesDir, 'stages', `${kebab(input.stage)}.md`));
  const stackGuideline = await readIfExists(path.join(input.guidelinesDir, 'stacks', STACK_FILE[input.stack]));
  const { sections, files: contextFiles } = planSections(input.stage, input.inputs);

  const files: Record<string, string> = {
    'prompt.md': buildPromptMd({ stage: input.stage, sections, instructions, attempt, stack: input.stack, stackGuideline }),
    'system.md': await buildSystemMd(input.guidelinesDir, input.stack, input.claudeMdMode),
    'schema.json': JSON.stringify(input.schema),
    'stage.json': JSON.stringify(stageJson, null, 2),
  };
  // Stages without a workspace cannot read files, and Jira stages have no Read tool, so they get no context files.
  if (!isJiraStage(input.stage)) for (const f of contextFiles) files[f.name] = f.content;
  if (isJiraStage(input.stage) && input.mcpConfigJson) files['mcp.json'] = input.mcpConfigJson;

  for (const [name, content] of Object.entries(files)) await writeFile(path.join(runDir, name), content, 'utf8');

  const hideFiles =
    hidesRepoClaudeMd(input.claudeMdMode) && input.workspacePath ? CLAUDE_MD_FILES.filter((f) => existsSync(path.join(input.workspacePath as string, f))) : [];
  return { runDir, stageJson, hideFiles: [...hideFiles], files: Object.keys(files) };
}
