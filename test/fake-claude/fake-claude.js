#!/usr/bin/env node
// fake-claude.js: a stand-in for the `claude` CLI in tests (BUILD_PLAN section 11). It never calls a model.
//
//   - reads the prompt from stdin; the first line `<!-- stage: <name> -->` names the stage
//   - loads scenarios/<FAKE_SCENARIO>/<stage>.json: a list of attempts (attempt n uses entry n, the last repeats)
//   - applies the entry's edits/deletes relative to the working directory (/workspace)
//   - prints stream-json: an init line, one assistant line, an optional rate_limit_event, and a result line
//   - exits with the entry's exitCode; delayMs waits first (for timeout and kill tests)
//
// Entry: { edits: [{ path, content }], deletes: [], result: <stage envelope>, usage: {...}, rateLimit?: {...},
//          exitCode?, delayMs?, subtype?: "error_max_turns", fenced?: true, noResult?: true, leakEnv?: ["NAME"],
//          promptMatches?: "regex" }
//   promptMatches selects the entry by the prompt text; attempt n then picks among the matching entries.
//   leakEnv prints those environment variables in the assistant text, to test that logs are redacted.
//
// Environment: FAKE_SCENARIO (default "default"), FAKE_SCENARIOS_DIR (default: ./scenarios next to this file),
//              CONTEXT_DIR (default /context; stage.json there supplies the attempt number), FAKE_ATTEMPT (override).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const fail = (message, code = 2) => {
  process.stderr.write(`fake-claude: ${message}\n`);
  process.exit(code);
};

const prompt = fs.readFileSync(0, 'utf8');
const marker = /^<!--\s*stage:\s*([A-Za-z]+)\s*-->/.exec(prompt.split('\n')[0] ?? '');
if (!marker) fail('the prompt must start with <!-- stage: <name> -->');
const stage = marker[1];

const scenario = process.env.FAKE_SCENARIO || 'default';
const dir = process.env.FAKE_SCENARIOS_DIR || path.join(__dirname, 'scenarios');
const file = path.join(dir, scenario, `${stage}.json`);
if (!fs.existsSync(file)) fail(`no scenario file ${file}`);
const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
const entries = Array.isArray(parsed) ? parsed : [parsed];

let attempt = Number(process.env.FAKE_ATTEMPT || 0);
if (!attempt) {
  try {
    const stageJson = JSON.parse(fs.readFileSync(path.join(process.env.CONTEXT_DIR || '/context', 'stage.json'), 'utf8'));
    attempt = Number(stageJson.attempt) || 1;
  } catch {
    attempt = 1;
  }
}
// An entry may carry `promptMatches` (a regular expression tested against the prompt), so one scenario can behave differently
// for different inputs, for example per subtask. Attempt n then picks among the entries that match.
const applicable = entries.filter((e) => !e.promptMatches || new RegExp(e.promptMatches).test(prompt));
if (applicable.length === 0) fail(`no entry of ${file} matches this prompt`);
const entry = applicable[Math.min(attempt - 1, applicable.length - 1)];

const safePath = (p) => {
  const resolved = path.resolve(process.cwd(), p);
  if (resolved !== process.cwd() && !resolved.startsWith(process.cwd() + path.sep)) fail(`path escapes the workspace: ${p}`, 1);
  return resolved;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

(async () => {
  if (entry.delayMs) await sleep(entry.delayMs);

  for (const edit of entry.edits ?? []) {
    const target = safePath(edit.path);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, edit.content);
    } catch (err) {
      fail(`cannot write ${edit.path}: ${err.message}`, 1); // for example a read-only workspace
    }
  }
  for (const del of entry.deletes ?? []) fs.rmSync(safePath(del), { force: true });

  const sessionId = `fake-${process.pid}`;
  const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...(entry.usage ?? {}) };
  emit({ type: 'system', subtype: 'init', claude_code_version: 'fake-claude', session_id: sessionId, model: 'fake' });
  const leaked = (entry.leakEnv ?? []).map((name) => ` ${name}=${process.env[name] ?? ''}`).join('');
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: `fake-claude ran stage ${stage} (attempt ${attempt})${leaked}` }] } });
  if (entry.rateLimit) emit({ type: 'rate_limit_event', rate_limit_info: entry.rateLimit });

  if (!entry.noResult) {
    const base = { type: 'result', num_turns: entry.numTurns ?? 2, duration_ms: 1, total_cost_usd: entry.costUsd ?? 0.001, session_id: sessionId, usage };
    if (entry.subtype === 'error_max_turns') {
      emit({ ...base, subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns', result: null, errors: ['Reached maximum number of turns'] });
    } else if (entry.fenced) {
      emit({ ...base, subtype: 'success', is_error: false, result: `Done.\n\`\`\`json\n${JSON.stringify(entry.result)}\n\`\`\`` });
    } else {
      emit({ ...base, subtype: 'success', is_error: false, result: '', structured_output: entry.result });
    }
  }
  process.exit(entry.exitCode ?? (entry.subtype === 'error_max_turns' ? 1 : 0));
})();
