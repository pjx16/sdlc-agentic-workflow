import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STAGE_NAMES, type ClaudeMdMode, type ModelAlias, type StageName } from '@sdlc/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildStageContext, buildSystemMd, type BuildContextInput, type StageInputs } from './context-builder';
import { STAGE_WORKSPACE, buildStageJson, hidesRepoClaudeMd, includesOurClaudeMd } from './stage-config';

let tmp: string;
let guidelines: string;
let n = 0;

const aliases: Record<ModelAlias, string> = { haiku: 'haiku', sonnet: 'sonnet', opus: 'claude-opus-5-5' };
const subtask = { seq: 2, title: 'Add parser', description: 'Parse the thing.', acceptanceCriteria: ['It parses', 'It rejects junk'], files: ['src/parser.ts'], dependsOn: [1] };
const inputs: StageInputs = {
  ticket: { key: 'ABC-1', title: 'Add parser', body: 'First paragraph of the body.\n\nSecond paragraph with more detail.' },
  kbDoc: '# KB\nthe doc', indexKeys: ['auth', 'billing'], plan: '# Plan\nDo it', subtask, testFiles: ['src/parser.test.ts'],
  exampleTestFile: 'src/util.test.ts', failureOutput: 'FAIL src/parser.test.ts\nexpected 1', acceptanceCriteria: ['It parses'],
  diff: 'diff --git a/x b/x', reviewChecklist: '- be correct', existingDoc: '# Old doc', docTemplate: '# Template', jql: 'project = ABC',
  projectKey: 'ABC', ticketSchema: '{"type":"object"}', syncPayload: '{"op":"comment"}',
};

async function build(stage: StageName, over: Partial<BuildContextInput> = {}, inputOver: Partial<StageInputs> = {}) {
  return buildStageContext({
    stageRunId: `run-${++n}`, stage, stack: 'nestjs', claudeMdMode: 'both', inputs: { ...inputs, ...inputOver }, schema: { type: 'object' },
    config: { stage, modelAlias: 'sonnet', modelAliases: aliases, maxTurns: 12 }, runsDir: path.join(tmp, 'runs'), guidelinesDir: guidelines, ...over,
  });
}

const headings = (prompt: string) => [...prompt.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
const read = (dir: string, name: string) => readFileSync(path.join(dir, name), 'utf8');

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-ctx-'));
  guidelines = path.join(tmp, 'guidelines');
  mkdirSync(path.join(guidelines, 'stacks'), { recursive: true });
  mkdirSync(path.join(guidelines, 'stages'), { recursive: true });
  writeFileSync(path.join(guidelines, 'stacks', 'nestjs.md'), 'NEST GUIDELINE\n');
  writeFileSync(path.join(guidelines, 'stacks', 'ts-node.md'), 'TS GUIDELINE\n');
  writeFileSync(path.join(guidelines, 'default-CLAUDE.md'), 'OUR CLAUDE MD\n');
  writeFileSync(path.join(guidelines, 'stages', 'plan.md'), 'PLAN INSTRUCTIONS\n');
  writeFileSync(path.join(guidelines, 'stages', 'kb-build.md'), 'KB BUILD INSTRUCTIONS\n');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('prompt.md (BUILD_PLAN 6.4)', () => {
  it('starts with the stage marker and ends with the output instructions', async () => {
    const { runDir } = await build('implement');
    const prompt = read(runDir, 'prompt.md');
    expect(prompt.split('\n')[0]).toBe('<!-- stage: implement -->');
    expect(headings(prompt).at(-1)).toBe('Output');
    expect(prompt).toContain('{ filesChanged[] }');
  });

  const expected: Record<StageName, string[]> = {
    kbBuild: ['Instructions', 'Ticket', 'Index keys', 'Stack guideline', 'Output'],
    plan: ['Instructions', 'Ticket', 'KB doc', 'Output'],
    breakdown: ['Ticket', 'Approved plan', 'KB doc', 'Output'],
    tests: ['Ticket', 'Approved plan', 'Subtask', 'KB doc', 'Example test file', 'Output'],
    implement: ['Ticket', 'Plan', 'Subtask', 'KB doc', 'Test files', 'Output'],
    fix: ['Failure output', 'Subtask', 'Output'],
    review: ['Acceptance criteria', 'Diff', 'Review checklist', 'Output'],
    kbUpdate: ['Diff', 'Existing doc', 'Doc template', 'Output'],
    jiraIntake: ['JQL', 'Project key', 'Ticket schema', 'Output'],
    jiraSync: ['Operation', 'Output'],
  };
  it.each(STAGE_NAMES)('%s has its sections in the documented order', async (stage) => {
    const { runDir } = await build(stage);
    expect(headings(read(runDir, 'prompt.md'))).toEqual(expected[stage]);
  });

  it('includes the stage instruction file (kebab-case name) when it exists', async () => {
    expect(read((await build('plan')).runDir, 'prompt.md')).toContain('PLAN INSTRUCTIONS');
    expect(read((await build('kbBuild')).runDir, 'prompt.md')).toContain('KB BUILD INSTRUCTIONS');
  });

  it('shows the stack guideline in the kbBuild prompt', async () => {
    expect(read((await build('kbBuild')).runDir, 'prompt.md')).toContain('NEST GUIDELINE');
  });

  it('adds the previous plan and the rejection note to a re-run of plan, and nothing on the first run', async () => {
    const first = await build('plan');
    expect(headings(read(first.runDir, 'prompt.md'))).not.toContain('Previous plan');
    const rerun = await build('plan', {}, { previousPlan: '# Old plan', rejectionNote: 'Use the existing queue, not a new table' });
    const prompt = read(rerun.runDir, 'prompt.md');
    expect(headings(prompt)).toEqual(['Instructions', 'Ticket', 'KB doc', 'Previous plan', 'Rejection note', 'Output']);
    expect(prompt).toContain('# Old plan');
    expect(prompt).toContain('Use the existing queue, not a new table');
  });

  it('gives breakdown its limit, and on a re-run the previous breakdown and the note', async () => {
    const first = await build('breakdown', {}, { maxSubtasks: 6 });
    expect(headings(read(first.runDir, 'prompt.md'))).toEqual(['Ticket', 'Approved plan', 'KB doc', 'Limits', 'Output']);
    expect(read(first.runDir, 'prompt.md')).toContain('At most 6 subtasks.');
    const rerun = await build('breakdown', {}, { maxSubtasks: 6, previousBreakdown: '[{"seq":1}]', rejectionNote: 'Split the API from the UI' });
    expect(headings(read(rerun.runDir, 'prompt.md'))).toEqual(['Ticket', 'Approved plan', 'KB doc', 'Limits', 'Previous breakdown', 'Rejection note', 'Output']);
    expect(read(rerun.runDir, 'prompt.md')).toContain('Split the API from the UI');
  });

  it('omits the previous-findings section unless there are findings, and the subtask for fix when absent', async () => {
    const withFindings = await build('review', {}, { previousFindings: [{ id: 'f1', severity: 'high', file: 'a.ts', line: 3, issue: 'bad', rule: 'r', fix: 'fix it' }] });
    expect(headings(read(withFindings.runDir, 'prompt.md'))).toContain('Previous findings');
    expect(read(withFindings.runDir, 'prompt.md')).toContain('[f1] high a.ts:3: bad');
    const fixNoSubtask = await build('fix', {}, { subtask: undefined });
    expect(headings(read(fixNoSubtask.runDir, 'prompt.md'))).toEqual(['Failure output', 'Output']);
  });

  it('notes retries and says when there is no KB doc', async () => {
    const retry = await build('implement', { config: { stage: 'implement', modelAlias: 'haiku', modelAliases: aliases, maxTurns: 40, attempt: 2 } });
    expect(read(retry.runDir, 'prompt.md')).toContain('partial changes');
    const noKb = await build('plan', {}, { kbDoc: undefined });
    expect(read(noKb.runDir, 'prompt.md')).toContain('No knowledge-base document exists');
  });

  it('gives tests and implement only a short ticket summary, plan and breakdown the full ticket file', async () => {
    const impl = await build('implement');
    expect(readdirSync(impl.runDir)).not.toContain('ticket.md');
    expect(read(impl.runDir, 'prompt.md')).toContain('First paragraph of the body.');
    expect(read(impl.runDir, 'prompt.md')).not.toContain('Second paragraph');
    const plan = await build('plan');
    expect(read(plan.runDir, 'ticket.md')).toContain('Second paragraph with more detail.');
  });

  it('writes diff.patch and kb.md as context files', async () => {
    const review = await build('review');
    expect(read(review.runDir, 'diff.patch')).toBe('diff --git a/x b/x');
    expect(read((await build('implement')).runDir, 'kb.md')).toBe('# KB\nthe doc');
  });

  it('keeps Jira stages self-contained: everything inline, no context files', async () => {
    const intake = await build('jiraIntake', { mcpConfigJson: '{"mcpServers":{}}' });
    expect(intake.files.sort()).toEqual(['mcp.json', 'prompt.md', 'schema.json', 'stage.json', 'system.md']);
    expect(read(intake.runDir, 'prompt.md')).toContain('project = ABC');
    expect(read(intake.runDir, 'mcp.json')).toBe('{"mcpServers":{}}');
  });

  it('writes schema.json verbatim', async () => {
    expect(JSON.parse(read((await build('plan', { schema: { type: 'object', required: ['status'] } })).runDir, 'schema.json'))).toEqual({ type: 'object', required: ['status'] });
  });
});

describe('system.md per CLAUDE.md mode', () => {
  it.each<[ClaudeMdMode, boolean]>([['ours', true], ['both', true], ['theirs', false]])('mode %s includes our CLAUDE.md: %s', async (mode, ours) => {
    const system = await buildSystemMd(guidelines, 'nestjs', mode);
    expect(system).toContain('NEST GUIDELINE');
    expect(system.includes('OUR CLAUDE MD')).toBe(ours);
    expect(includesOurClaudeMd(mode)).toBe(ours);
  });

  it('uses the guideline of the project stack and tolerates missing files', async () => {
    expect(await buildSystemMd(guidelines, 'ts_node', 'theirs')).toContain('TS GUIDELINE');
    expect(await buildSystemMd(path.join(tmp, 'nothing'), 'nextjs', 'both')).toBe('');
  });
});

describe('hide-mount decision', () => {
  it('only mode ours hides the repository CLAUDE.md, and only files that exist', async () => {
    const ws = path.join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, 'CLAUDE.md'), 'repo rules');
    expect((await build('implement', { claudeMdMode: 'ours', workspacePath: ws })).hideFiles).toEqual(['CLAUDE.md']);
    writeFileSync(path.join(ws, 'CLAUDE.local.md'), 'local');
    expect((await build('implement', { claudeMdMode: 'ours', workspacePath: ws })).hideFiles).toEqual(['CLAUDE.md', 'CLAUDE.local.md']);
    expect((await build('implement', { claudeMdMode: 'both', workspacePath: ws })).hideFiles).toEqual([]);
    expect((await build('implement', { claudeMdMode: 'theirs', workspacePath: ws })).hideFiles).toEqual([]);
    expect((await build('implement', { claudeMdMode: 'ours' })).hideFiles).toEqual([]);
    expect(hidesRepoClaudeMd('ours')).toBe(true);
  });
});

describe('stage.json', () => {
  it('resolves the model alias and disables web tools for every stage', () => {
    const j = buildStageJson({ stage: 'plan', modelAlias: 'opus', modelAliases: aliases, maxTurns: 15 });
    expect(j).toMatchObject({ model: 'claude-opus-5-5', maxTurns: 15, attempt: 1, round: 0 });
    expect(j.disallowedTools).toEqual(['WebFetch', 'WebSearch', 'Edit', 'Write', 'NotebookEdit']);
    for (const stage of STAGE_NAMES) expect(buildStageJson({ stage, modelAlias: 'haiku', modelAliases: aliases, maxTurns: 1 }).disallowedTools).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch']));
  });

  it('only read-only stages lose the edit tools', () => {
    for (const stage of STAGE_NAMES) {
      const d = buildStageJson({ stage, modelAlias: 'haiku', modelAliases: aliases, maxTurns: 1 }).disallowedTools;
      expect(d.includes('Edit')).toBe(STAGE_WORKSPACE[stage] !== 'rw');
    }
  });

  it('gives Jira stages only the listed MCP tools and no file or shell tools', () => {
    const j = buildStageJson({ stage: 'jiraIntake', modelAlias: 'haiku', modelAliases: aliases, maxTurns: 10, jiraTools: ['getJiraIssue', 'searchJiraIssuesUsingJql'] });
    expect(j.allowedTools).toEqual(['mcp__atlassian__getJiraIssue', 'mcp__atlassian__searchJiraIssuesUsingJql']);
    expect(j.mcpConfig).toBe(true);
    expect(j.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'WebSearch']));
  });
});
