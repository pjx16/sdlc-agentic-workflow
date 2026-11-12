import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ProjectStack } from '@sdlc/shared';
import { buildStageContext, buildSystemMd } from './context-builder';

const GUIDELINES = path.resolve(__dirname, '../../../../../guidelines');
const read = (rel: string) => readFileSync(path.join(GUIDELINES, rel), 'utf8');

describe('shipped guideline files (BUILD_PLAN 6.9)', () => {
  it('has every file this milestone owns', () => {
    for (const f of ['default-CLAUDE.md', 'kb-doc-template.md', 'stacks/ts-node.md', 'stacks/nestjs.md', 'stacks/nextjs.md', 'stages/kb-build.md', 'stages/plan.md', 'stages/breakdown.md', 'stages/tests.md', 'stages/implement.md', 'stages/fix.md']) expect(existsSync(path.join(GUIDELINES, f)), f).toBe(true);
  });

  it('default-CLAUDE.md carries the required rules', () => {
    const t = read('default-CLAUDE.md');
    for (const needle of ['needs_input', 'git commit', 'git push', 'git reset', '`rg -n`', 'about 60 lines', 'node_modules', 'dist', 'coverage', 'lockfiles', 'secrets', 'JSON object']) expect(t, needle).toContain(needle);
  });

  it('kb-doc-template.md names every required section', () => {
    const t = read('kb-doc-template.md');
    for (const h of ['## Overview', '## Entry points', '## Flow', '## Data touched', '## External calls', '## Edge cases and business rules', '## Open questions']) expect(t, h).toContain(h);
    expect(t).toContain('file:line');
    expect(t).toContain('kbDocMaxLines');
  });

  it('every stage file states purpose, inputs, steps, constraints, the data shape and when to use needs_input', () => {
    for (const f of ['stages/kb-build.md', 'stages/plan.md', 'stages/breakdown.md', 'stages/tests.md', 'stages/implement.md', 'stages/fix.md']) {
      const t = read(f);
      for (const needle of ['**Purpose.**', '**Inputs**', '**Steps**', '**Constraints**', '**Output `data`**', '`needs_input`']) expect(t, `${f} ${needle}`).toContain(needle);
    }
    expect(read('stages/plan.md')).toContain('{ "planMarkdown": string, "risks": string[], "openQuestions": string[] }');
    expect(read('stages/kb-build.md')).toContain('{ "featureKey": string, "isNew": boolean, "docPath": string, "globs": string[] }');
    expect(read('stages/plan.md')).toContain('read-only');
  });

  it('stack guidelines cover conventions, error handling, tests and what to avoid', () => {
    for (const f of ['stacks/ts-node.md', 'stacks/nestjs.md', 'stacks/nextjs.md']) {
      const t = read(f).toLowerCase();
      for (const needle of ['tests', 'avoid']) expect(t, `${f} ${needle}`).toContain(needle);
    }
    expect(read('stacks/ts-node.md')).toContain('Strict TypeScript');
    expect(read('stacks/nestjs.md')).toContain('DTO validation');
    expect(read('stacks/nextjs.md')).toContain('Server Components');
  });
});

describe('the prompt builder picks the shipped files up', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-gl-'));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it.each<[ProjectStack, string]>([['ts_node', 'Strict TypeScript'], ['nestjs', 'DTO validation'], ['nextjs', 'Server Components']])('system.md for %s has its stack guideline and our CLAUDE.md', async (stack, marker) => {
    const system = await buildSystemMd(GUIDELINES, stack, 'both');
    expect(system).toContain(marker);
    expect(system).toContain('You run headless');
    expect(await buildSystemMd(GUIDELINES, stack, 'theirs')).not.toContain('You run headless');
  });

  const aliases = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' } as const;
  const build = (stage: 'plan' | 'kbBuild', inputs = {}) =>
    buildStageContext({ stageRunId: `r-${stage}`, stage, stack: 'nestjs', claudeMdMode: 'both', inputs: { ticket: { key: 'A-1', title: 't', body: 'b' }, ...inputs }, schema: {}, config: { stage, modelAlias: 'opus', modelAliases: aliases, maxTurns: 5 }, runsDir: tmp, guidelinesDir: GUIDELINES });

  it('puts the plan stage instructions into the plan prompt', async () => {
    const { runDir } = await build('plan');
    expect(readFileSync(path.join(runDir, 'prompt.md'), 'utf8')).toContain('# Stage: plan');
  });

  it('puts the kb-build instructions, the stack guideline, and the KB location into the kbBuild prompt', async () => {
    const { runDir } = await build('kbBuild', { indexKeys: ['auth'], kbDir: 'docs/kb', kbDocMaxLines: 300 });
    const prompt = readFileSync(path.join(runDir, 'prompt.md'), 'utf8');
    expect(prompt).toContain('# Stage: kbBuild');
    expect(prompt).toContain('Write a new doc under `docs/kb/`');
    expect(prompt).toContain('at most 300 lines');
    expect(prompt).toContain('DTO validation');
  });
});
