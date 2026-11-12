import { execFileSync } from 'node:child_process';

export interface Change {
  status: string;
  path: string;
}

/** Parses `git status --porcelain=v1 -z`: one entry per file, renames split into the new path (added) and the old (deleted). */
export function parsePorcelain(out: string): Change[] {
  const parts = out.split('\0').filter(Boolean);
  const entries: Change[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    const status = part.slice(0, 2);
    const file = part.slice(3);
    if (status[0] === 'R' || status[0] === 'C') {
      const source = parts[++i] as string;
      entries.push({ status: 'A ', path: file });
      if (status[0] === 'R') entries.push({ status: ' D', path: source });
    } else {
      entries.push({ status, path: file });
    }
  }
  return entries;
}

/** Changed and new files in a workspace, ignoring installed dependencies. Synchronous, for stage output validation. */
export function changedFilesSync(workspace: string): Change[] {
  const out = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: workspace, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return parsePorcelain(out).filter((c) => !c.path.startsWith('node_modules/') && !c.path.startsWith('.git/'));
}
