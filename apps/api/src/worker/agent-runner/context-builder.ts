import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promptFileOf, type ClaudeMdMode, type ProjectStack, type StageName } from '@sdlc/shared';
import { CLAUDE_MD_FILES, buildStageJson, hidesRepoClaudeMd, includesOurClaudeMd, type StageConfigInput, type StageJson } from './stage-config';

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
  /** For kbBuild: where the doc goes and how long it may be. */
  kbDir?: string;
  kbDocMaxLines?: number;
  /** For the documentor in create mode: the key the feature mapper chose. */
  featureKey?: string;
  plan?: string;
  /** For a re-run of `plan` after a rejection (F7). */
  previousPlan?: string;
  /** For breakdown: the limit, and on a re-run the previous list (as JSON) and the rejection note. */
  maxSubtasks?: number;
  previousBreakdown?: string;
  rejectionNote?: string;
  subtask?: SubtaskInfo;
  testFiles?: string[];
  exampleTestFile?: string;
  /** For a retry of `tests` after an invalid red: why the previous tests were rejected. */
  previousAttempt?: string;
  /** Verify tail, open critical/high findings, or CI log tail, for `fix`. */
  failureOutput?: string;
  acceptanceCriteria?: string[];
  diff?: string;
  /** For a diff above reviewMaxDiffLines: the stat and the range, so the stage reads it file by file instead. */
  diffStat?: string;
  diffRange?: string;
  diffLines?: number;
  reviewChecklist?: string;
  previousFindings?: FindingInfo[];
  /** For the security reviewer: the rules that matched. */
  securityReasons?: string[];
  /** For the orchestrator: a short summary of one ticket at a decision point. Never code or diffs. */
  orchestrate?: { ticketKey: string; kind: string; state: string; question: string; moves: { kind: string; to: string; label: string; isDefault: boolean }[]; events: string[]; lastSummary: string; counts: string; findings: string[]; supportTickets: string[]; facts?: string };
  /** For the CI triager. */
  ci?: { check: string; logTail: string; reruns: number };
  /** Earlier questions this stage asked for the ticket and the developer's answers (F13), oldest first. */
  qa?: { question: string; answer: string }[];
  /** Set on an automatic retry: why the last attempt failed (validation errors, or what the guard found), so the agent can avoid it. */
  retryNote?: string;
  existingDoc?: string;
  docTemplate?: string;
  /** The assistant: the context pack of one support ticket, what was said before, and the new message. */
  /** The stage is running again because a person sent the ticket back: their note, and what the stale attempt produced (BUILD_PLAN v1 6.8). */
  rerun?: { note: string; previous?: string };
  /** Onboarding: the facts code collected, as plain text. */
  onboard?: { facts: string };
  assist?: { pack: string; summary?: string | null; history: { role: 'user' | 'assistant'; text: string }[]; message: string };
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
}

export interface BuiltContext {
  runDir: string;
  stageJson: StageJson;
  /** Files to hide in /workspace with an empty bind mount (mode `ours`, only those that exist). */
  hideFiles: string[];
  files: string[];
}

const STACK_FILE: Record<ProjectStack, string> = { ts_node: 'ts-node.md', nestjs: 'nestjs.md', nextjs: 'nextjs.md' };

/** What each stage's `data` object must contain (BUILD_PLAN 6.5), as plain text for the prompt. */
const DATA_SHAPES: Record<StageName, string> = {
  kbBuild: '{ featureKey, isNew (true), docPath, globs[] }',
  orchestrate: '{ move: { kind, to }, reason }. `move` must be exactly one of the legal moves.',
  featureMap: '{ featureKey, isNew, reason }. If isNew is false, featureKey must be a key from the list.',
  solutionDesign: '{ planMarkdown, risks[], openQuestions[] }',
  bugInvestigation: '{ planMarkdown, risks[], openQuestions[], rootCause: { file, line, explanation } }',
  technicalDesign: '{ subtasks: [{ seq, title, description, acceptanceCriteria[], files[], dependsOn[] }], filesByOrder: [path, ...] (the files in the order they are changed) }',
  tests: '{ testFiles[], criteriaCovered: [{ criterion, test }] }',
  implement: '{ filesChanged[] }',
  fix: '{ filesChanged[] }',
  prReview: '{ criteria: [{ criterion, met, tested, note }], findings: [{ severity, file, line (nullable), issue, rule, fix }], previousFindings: [{ id, status: "fixed" | "still_open" }] }',
  qualityReview: '{ findings: [{ severity (at most medium), file, line (nullable), issue, rule, fix }], previousFindings: [{ id, status: "fixed" | "still_open" }] }',
  securityReview: '{ findings: [{ severity, file, line (nullable), issue, rule, fix }], previousFindings: [{ id, status: "fixed" | "still_open" }] }',
  ciTriage: '{ kind: "code" | "flaky" | "infra", failingCommand (optional), summary }',
  kbUpdate: '{ featureKey, docPath, changed }',
  repoProfile: '{ stack: "ts_node" | "nestjs" | "nextjs", installCmd, typecheckCmd, testCmdTemplate (must contain {files}), kbDir, testFilePattern, exampleTestFile (a path, or null) }',
  onboardAdvise: '{ statusMap: { <internal state>: <Jira status name or null> }, approvalStatuses: { plan, breakdown }, issueTypeRouting: { <issue type>: "feature" | "bug" | "chore" | "ignore" }, intakeLabel, confluenceSpaceKey (a space key from the list, or null) }',
  assist: '{ reply, draft }. `reply` is your answer to the person, in plain words. `draft` is null, or { kind: "answer" | "plan_edit" | "rerun_note", text } when you have something they can apply with one click: the answer to the question, the whole edited plan, or the note for a rerun.',
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
    if (i.diffStat !== undefined) {
      // Too large to hand over whole: give the stat and let the stage read it file by file.
      return {
        heading: 'Diff',
        body: `The diff is large (${i.diffLines ?? 'many'} lines), so it is not included. Read it file by file with \`git diff ${i.diffRange ?? 'HEAD~1'} -- <file>\`, starting with the files that matter most.\n\n${fenced(i.diffStat)}`,
      };
    }
    files.push({ name: 'diff.patch', content: i.diff ?? '' });
    return { heading: 'Diff', body: 'The change under review is in /context/diff.patch.' };
  };

  switch (stage) {
    case 'featureMap':
      sections.push(ticketFull(), { heading: 'Index keys', body: list(i.indexKeys ?? []) });
      break;
    case 'kbBuild':
      sections.push({ heading: 'Mode', body: 'Mode: **create**. There is no doc for this feature yet.' }, ticketFull(), {
        heading: 'Index keys',
        body: `${i.featureKey ? `Use this feature key: \`${i.featureKey}\`.\n\n` : ''}${list(i.indexKeys ?? [])}${i.kbDir ? `\n\nWrite a new doc under \`${i.kbDir}/\` (for example \`${i.kbDir}/<featureKey>.md\`)${i.kbDocMaxLines ? `, at most ${i.kbDocMaxLines} lines` : ''}.` : ''}`,
      });
      break;
    case 'solutionDesign':
    case 'bugInvestigation':
      sections.push(ticketFull(), kb());
      if (i.previousPlan) sections.push({ heading: 'Previous plan', body: i.previousPlan });
      if (i.rejectionNote) sections.push({ heading: 'Rejection note', body: `The developer rejected the previous plan with this note. Address every point.\n\n${i.rejectionNote}` });
      break;
    case 'technicalDesign':
      sections.push(ticketFull(), { heading: 'Approved plan', body: i.plan ?? '_No plan._' }, kb());
      if (i.maxSubtasks) sections.push({ heading: 'Limits', body: `At most ${i.maxSubtasks} subtasks.` });
      if (i.previousBreakdown) sections.push({ heading: 'Previous breakdown', body: fenced(i.previousBreakdown) });
      if (i.rejectionNote) sections.push({ heading: 'Rejection note', body: `The developer rejected the previous breakdown with this note. Address every point.\n\n${i.rejectionNote}` });
      break;
    case 'tests':
      sections.push(ticketSummary(), { heading: 'Approved plan', body: i.plan ?? '_No plan._' }, { heading: 'Subtask', body: i.subtask ? subtaskText(i.subtask) : '_No subtask._' }, kb(), {
        heading: 'Example test file',
        body: i.exampleTestFile ?? '_No example test file found._',
      });
      if (i.previousAttempt) sections.push({ heading: 'Previous attempt', body: `Your previous tests were rejected. Fix the cause and keep what was fine.\n\n${fenced(i.previousAttempt)}` });
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
    case 'prReview':
    case 'qualityReview':
    case 'securityReview':
      if (stage === 'securityReview' && i.securityReasons?.length) sections.push({ heading: 'Why you were brought in', body: list(i.securityReasons) });
      sections.push({ heading: 'Acceptance criteria', body: list(i.acceptanceCriteria ?? []) }, diff(), { heading: 'Review checklist', body: i.reviewChecklist ?? '_No checklist._' });
      if (i.previousFindings && i.previousFindings.length > 0) sections.push({ heading: 'Previous findings', body: findingsText(i.previousFindings) });
      break;
    case 'orchestrate': {
      const o = i.orchestrate;
      sections.push(
        { heading: 'Ticket', body: o ? `${o.ticketKey} (${o.kind}), state ${o.state}` : '_No ticket._' },
        { heading: 'Question', body: o?.question ?? '' },
        { heading: 'Legal moves', body: list((o?.moves ?? []).map((m) => `${m.kind} ${m.to}${m.isDefault ? ' (default)' : ''}: ${m.label}`)) },
        { heading: 'Recent events', body: list(o?.events ?? []) },
        { heading: 'Last stage', body: o?.lastSummary || '_none_' },
        { heading: 'Counts', body: o?.counts ?? '' },
        { heading: 'Open findings', body: list(o?.findings ?? []) },
        { heading: 'Open support tickets', body: list(o?.supportTickets ?? []) },
      );
      if (o?.facts) sections.push({ heading: 'More facts', body: o.facts });
      break;
    }
    case 'ciTriage':
      sections.push({ heading: 'Failing check', body: i.ci?.check ?? '_unknown_' }, { heading: 'Times the checks were run again', body: String(i.ci?.reruns ?? 0) }, { heading: 'Log tail', body: fenced(i.ci?.logTail ?? '') });
      break;
    case 'repoProfile':
      sections.push({ heading: 'Facts', body: i.onboard?.facts ?? '_No facts._' });
      break;
    case 'onboardAdvise':
      sections.push({ heading: 'Facts', body: i.onboard?.facts ?? '_No facts._' });
      break;
    case 'assist': {
      const a = i.assist;
      const said = a ? [a.summary ? `Summary of the earlier conversation: ${a.summary}` : '', ...a.history.map((m) => `${m.role === 'user' ? 'Person' : 'You'}: ${m.text}`)].filter(Boolean).join('\n\n') : '';
      sections.push({ heading: 'Context', body: a?.pack ?? '_No context._' }, { heading: 'Conversation so far', body: said || '_Nothing yet._' }, { heading: 'Message', body: a?.message ?? '' });
      break;
    }
    case 'kbUpdate':
      sections.push({ heading: 'Mode', body: 'Mode: **refresh**. The doc exists; make it true again.' }, diff(), { heading: 'Existing doc', body: i.existingDoc ? fenced(i.existingDoc) : NO_KB }, { heading: 'Doc template', body: i.docTemplate ?? '_No template._' });
      break;
  }
  if (i.rerun) {
    sections.push({
      heading: 'Rerun',
      body: `A developer sent this ticket back to this stage. Do the work again, and address their note.\n\nNote: ${i.rerun.note}${i.rerun.previous ? `\n\nPrevious attempt (stale, kept so you can see what to change):\n\n${i.rerun.previous}` : ''}`,
    });
  }
  if (i.retryNote) {
    sections.push({ heading: 'Previous attempt failed', body: `Your last attempt was rejected. Fix exactly this and return the result again:\n\n${i.retryNote}` });
  }
  if (i.qa && i.qa.length > 0) {
    sections.push({
      heading: 'Earlier questions and answers',
      body: `You asked these questions on an earlier run of this stage; the developer answered. Do not ask them again.\n\n${i.qa.map((x, n) => `${n + 1}. Q: ${x.question}\n   A: ${x.answer}`).join('\n\n')}`,
    });
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
  const instructions = await readIfExists(path.join(input.guidelinesDir, 'stages', `${promptFileOf(input.stage)}.md`));
  const stackGuideline = await readIfExists(path.join(input.guidelinesDir, 'stacks', STACK_FILE[input.stack]));
  const { sections, files: contextFiles } = planSections(input.stage, input.inputs);

  const files: Record<string, string> = {
    'prompt.md': buildPromptMd({ stage: input.stage, sections, instructions, attempt, stack: input.stack, stackGuideline }),
    'system.md': await buildSystemMd(input.guidelinesDir, input.stack, input.claudeMdMode),
    'schema.json': JSON.stringify(input.schema),
    'stage.json': JSON.stringify(stageJson, null, 2),
  };
  for (const f of contextFiles) files[f.name] = f.content;

  for (const [name, content] of Object.entries(files)) await writeFile(path.join(runDir, name), content, 'utf8');

  const hideFiles =
    hidesRepoClaudeMd(input.claudeMdMode) && input.workspacePath ? CLAUDE_MD_FILES.filter((f) => existsSync(path.join(input.workspacePath as string, f))) : [];
  return { runDir, stageJson, hideFiles: [...hideFiles], files: Object.keys(files) };
}
