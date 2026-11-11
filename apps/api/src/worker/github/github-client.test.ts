import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GhCliClient, GitHubError, parseRepo } from './github-client';

/**
 * A stand-in for the `gh` executable. It records its arguments (and the body file it was given), answers from FAKE_GH_REPLIES
 * (a JSON map from "<cmd> <sub>" to { stdout, stderr, exit }), and checks that GH_TOKEN is set.
 */
const STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const bodyIdx = args.indexOf('--body-file');
const record = { args, token: process.env.GH_TOKEN, body: bodyIdx >= 0 ? fs.readFileSync(args[bodyIdx + 1], 'utf8') : null };
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(record) + '\\n');
const replies = JSON.parse(process.env.FAKE_GH_REPLIES || '{}');
const r = replies[args.slice(0, 2).join(' ')] || { stdout: '' };
if (r.stderr) process.stderr.write(r.stderr);
if (r.stdout) process.stdout.write(r.stdout);
process.exit(r.exit || 0);
`;

let tmp: string;
let log: string;
let client: GhCliClient;
const reply = (replies: Record<string, { stdout?: string; stderr?: string; exit?: number }>) => {
  process.env.FAKE_GH_REPLIES = JSON.stringify(replies);
};
const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; token: string; body: string | null });

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-gh-'));
  const bin = path.join(tmp, 'gh');
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  log = path.join(tmp, 'calls.log');
  process.env.FAKE_GH_LOG = log;
  client = new GhCliClient({ token: 'ghs_secret_token_value', binary: bin, tmpDir: tmp });
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  writeFileSync(log, '');
  reply({});
});

describe('parseRepo', () => {
  it('extracts owner/name from a github.com URL', () => {
    expect(parseRepo('https://github.com/acme/billing')).toBe('acme/billing');
    expect(parseRepo('https://github.com/acme/billing.git')).toBe('acme/billing');
    expect(parseRepo('https://github.com/acme/billing/')).toBe('acme/billing');
    expect(parseRepo('https://github.com/a-b/c_d.e')).toBe('a-b/c_d.e');
  });
  it('rejects anything else', () => {
    for (const bad of ['https://gitlab.com/a/b', 'git@github.com:a/b.git', 'http://github.com/a/b', 'https://github.com/a', 'https://github.com/a/b/c/d', 'file:///tmp/x.git', '']) expect(() => parseRepo(bad), bad).toThrow(GitHubError);
  });
});

describe('GhCliClient (BUILD_PLAN 6.3)', () => {
  it('opens a draft PR with gh pr create --draft, passing the body as a file, and reads the number from the URL', async () => {
    reply({ 'pr create': { stdout: 'Creating draft pull request...\nhttps://github.com/acme/billing/pull/42\n' } });
    const pr = await client.openDraftPr({ repo: 'acme/billing', base: 'dev', head: 'feature/ABC-1-x', title: 'ABC-1: Export', body: '## Summary\nhello `code` $(not run)' });
    expect(pr).toEqual({ number: 42, url: 'https://github.com/acme/billing/pull/42' });
    const [c] = calls();
    expect(c?.args.slice(0, 3)).toEqual(['pr', 'create', '--draft']);
    expect(c?.args).toEqual(expect.arrayContaining(['-R', 'acme/billing', '--base', 'dev', '--head', 'feature/ABC-1-x', '--title', 'ABC-1: Export']));
    expect(c?.args).toContain('--body-file');
    expect(c?.body).toBe('## Summary\nhello `code` $(not run)');
    expect(c?.args.join(' ')).not.toContain('hello'); // the body is never on the command line
    expect(c?.token).toBe('ghs_secret_token_value');
  });

  it('fails clearly when gh does not print a PR URL, and redacts the token from errors', async () => {
    reply({ 'pr create': { stdout: 'something odd\n' } });
    await expect(client.openDraftPr({ repo: 'a/b', base: 'dev', head: 'h', title: 't', body: 'b' })).rejects.toThrow(/could not read the pull request URL/);
    reply({ 'pr create': { stderr: 'HTTP 401: bad credentials ghs_secret_token_value\n', exit: 1 } });
    const err = await client.openDraftPr({ repo: 'a/b', base: 'dev', head: 'h', title: 't', body: 'b' }).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.message).toContain('bad credentials');
    expect(err.message).not.toContain('ghs_secret_token_value');
  });

  it('marks ready, comments and edits the body with the documented commands', async () => {
    await client.markReady('acme/billing', 42);
    await client.comment('acme/billing', 42, '## Review — round 1');
    await client.editBody('acme/billing', 42, 'new body');
    const [ready, comment, edit] = calls();
    expect(ready?.args).toEqual(['pr', 'ready', '42', '-R', 'acme/billing']);
    expect(comment?.args.slice(0, 4)).toEqual(['pr', 'comment', '42', '-R']);
    expect(comment?.body).toBe('## Review — round 1');
    expect(edit?.args.slice(0, 2)).toEqual(['pr', 'edit']);
    expect(edit?.body).toBe('new body');
  });

  it('reads checks as name and bucket, including when gh exits non-zero for pending or failing checks', async () => {
    reply({ 'pr checks': { stdout: JSON.stringify([{ name: 'build', bucket: 'pass' }, { name: 'lint', bucket: 'fail' }, { name: 'e2e', bucket: 'pending' }]), exit: 8 } });
    expect(await client.checks('acme/billing', 42)).toEqual([{ name: 'build', bucket: 'pass' }, { name: 'lint', bucket: 'fail' }, { name: 'e2e', bucket: 'pending' }]);
    expect(calls()[0]?.args).toEqual(['pr', 'checks', '42', '-R', 'acme/billing', '--json', 'name,bucket']);
  });

  it('a PR with no checks is an empty list (it counts as passing)', async () => {
    reply({ 'pr checks': { stderr: "no checks reported on the 'feature/x' branch", exit: 1 } });
    expect(await client.checks('acme/billing', 42)).toEqual([]);
    reply({ 'pr checks': { stdout: '[]' } });
    expect(await client.checks('acme/billing', 42)).toEqual([]);
  });

  it('reads the PR state and merge time', async () => {
    reply({ 'pr view': { stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-11-12T10:00:00Z' }) } });
    expect(await client.prState('acme/billing', 42)).toEqual({ state: 'MERGED', mergedAt: '2026-11-12T10:00:00Z' });
    reply({ 'pr view': { stdout: JSON.stringify({ state: 'OPEN', mergedAt: null }) } });
    expect(await client.prState('acme/billing', 42)).toEqual({ state: 'OPEN', mergedAt: null });
    expect(calls().at(-1)?.args).toEqual(['pr', 'view', '42', '-R', 'acme/billing', '--json', 'state,mergedAt']);
  });

  it('returns the last 60 lines of the latest failed run, found with gh run list', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `log line ${i + 1}`).join('\n');
    reply({
      'run list': { stdout: JSON.stringify([{ databaseId: 9, conclusion: 'success' }, { databaseId: 8, conclusion: 'failure' }, { databaseId: 7, conclusion: 'failure' }]) },
      'run view': { stdout: lines },
    });
    const tail = await client.failingLogTail('acme/billing', 'feature/x');
    expect(tail.split('\n')).toHaveLength(60);
    expect(tail.startsWith('log line 41')).toBe(true);
    const [list, view] = calls();
    expect(list?.args).toEqual(['run', 'list', '-R', 'acme/billing', '--branch', 'feature/x', '--json', 'databaseId,conclusion', '--limit', '5']);
    expect(view?.args).toEqual(['run', 'view', '8', '-R', 'acme/billing', '--log-failed']);
  });

  it('returns an empty tail when no run failed', async () => {
    reply({ 'run list': { stdout: JSON.stringify([{ databaseId: 1, conclusion: 'success' }]) } });
    expect(await client.failingLogTail('a/b', 'x')).toBe('');
    expect(calls()).toHaveLength(1);
  });
});
