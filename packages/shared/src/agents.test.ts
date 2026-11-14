import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENTS, promptFileOf, renderAgentFile } from './agents';
import { STAGE_NAMES } from './enums';

const root = path.resolve(__dirname, '../../..');

describe('the agent roster', () => {
  it('has one row per agent and every pipeline stage runs exactly one agent', () => {
    expect(AGENTS).toHaveLength(16);
    expect(new Set(AGENTS.map((a) => a.name)).size).toBe(AGENTS.length);
    for (const stage of STAGE_NAMES) expect(AGENTS.filter((a) => a.stages.includes(stage))).toHaveLength(1);
  });
  it('the documentor serves both knowledge-base stages', () => {
    expect(promptFileOf('kbBuild')).toBe('documentor');
    expect(promptFileOf('kbUpdate')).toBe('documentor');
  });
  it('every agent has a prompt file, and the prompt files are exactly the roster', () => {
    for (const a of AGENTS) expect(existsSync(path.join(root, 'guidelines/stages', `${a.name}.md`))).toBe(true);
    const files = readdirSync(path.join(root, 'guidelines/stages')).map((f) => f.replace(/\.md$/, '')).sort();
    expect(files).toEqual(AGENTS.map((a) => a.name).sort());
  });
  it('the files in .claude/agents are generated from the prompts and not edited by hand (run `npm run agents`)', () => {
    for (const a of AGENTS) {
      const prompt = readFileSync(path.join(root, 'guidelines/stages', `${a.name}.md`), 'utf8');
      expect(readFileSync(path.join(root, '.claude/agents', `sdlc-${a.name}.md`), 'utf8')).toBe(renderAgentFile(a, prompt));
    }
    const onDisk = readdirSync(path.join(root, '.claude/agents')).filter((f) => f.startsWith('sdlc-'));
    expect(onDisk.sort()).toEqual(AGENTS.map((a) => `sdlc-${a.name}.md`).sort());
  });
  it('a writing agent may edit; a read-only one may not', () => {
    const tools = (name: string) => /tools: (.*)/.exec(renderAgentFile(AGENTS.find((a) => a.name === name)!, ''))?.[1];
    expect(tools('coder')).toContain('Edit');
    expect(tools('pr-reviewer')).not.toContain('Edit');
    expect(tools('ci-triager')).toBe('Read');
  });
});
