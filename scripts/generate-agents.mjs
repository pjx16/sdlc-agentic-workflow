// Writes .claude/agents/sdlc-<name>.md from guidelines/stages/<name>.md for every agent in the roster
// (packages/shared/src/agents.ts), and removes sdlc-* files of agents that no longer exist.
// Run `npm run build -w @sdlc/shared` first. `--check` only reports drift and exits 1 when a file is out of date.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { AGENTS, renderAgentFile } = createRequire(import.meta.url)(path.join(root, 'packages/shared/dist/index.js'));
const out = path.join(root, '.claude/agents');
const check = process.argv.includes('--check');
mkdirSync(out, { recursive: true });

const wanted = new Map();
for (const agent of AGENTS) {
  const prompt = readFileSync(path.join(root, 'guidelines/stages', `${agent.name}.md`), 'utf8');
  wanted.set(`sdlc-${agent.name}.md`, renderAgentFile(agent, prompt));
}
let drift = 0;
for (const [file, text] of wanted) {
  const target = path.join(out, file);
  if (!existsSync(target) || readFileSync(target, 'utf8') !== text) {
    drift++;
    if (!check) writeFileSync(target, text);
  }
}
for (const file of readdirSync(out)) {
  if (file.startsWith('sdlc-') && !wanted.has(file)) {
    drift++;
    if (!check) rmSync(path.join(out, file));
  }
}
console.log(check ? `${drift} agent file(s) out of date` : `${wanted.size} agent files written, ${drift} changed`);
process.exit(check && drift > 0 ? 1 : 0);
