import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { composeArgs, isRunning } from './compose';
import { up } from './commands';
import { envFor, runDoctor } from './doctor';
import { getEnv, setEnv, writeEnvFile } from './envfile';
import { type Manifest, readManifest, sha256, shippedGuidelineHashes, writeManifest } from './manifest';
import { assetsDir, packageVersion } from './paths';
import { confirm } from './prompt';
import { generateEncryptionKey, generatePostgresPassword, generateSetupCode } from './secrets';
import { CliError, out, yellow } from './ui';

/** Semver comparison with pre-releases (`0.0.2-rc.1` < `0.0.2`): <0, 0 or >0. */
export function compareSemver(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split(/-(.+)/);
    return { nums: (core as string).split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ? pre.split('.') : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre.length === 0 && y.pre.length === 0) return 0;
  if (x.pre.length === 0) return 1;
  if (y.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (!pn && p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export interface ChangelogSection {
  version: string;
  text: string;
}

/** The `## [x.y.z]` sections of a changelog, newest first, `Unreleased` excluded. */
export function changelogSections(changelog: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | null = null;
  for (const line of changelog.split('\n')) {
    const m = /^## \[([^\]]+)\]/.exec(line);
    if (m) {
      current = m[1] === 'Unreleased' ? null : { version: m[1] as string, text: '' };
      if (current) sections.push(current);
      continue;
    }
    if (/^\[[^\]]+\]: /.test(line)) {
      current = null; // the link definitions at the end
      continue;
    }
    if (current) current.text += `${line}\n`;
  }
  return sections;
}

/** The sections after `from` up to and including `to`. */
export function sliceChangelog(changelog: string, from: string, to: string): ChangelogSection[] {
  return changelogSections(changelog).filter((s) => compareSemver(s.version, from) > 0 && compareSemver(s.version, to) <= 0);
}

/** Whether the user must confirm: a "Breaking" note, or a major/minor change (every minor counts while the major is 0). */
export function needsConfirmation(from: string, to: string, sections: ChangelogSection[]): boolean {
  if (sections.some((s) => /breaking/i.test(s.text))) return true;
  const [fm, fn] = from.split(/[.-]/).map(Number);
  const [tm, tn] = to.split(/[.-]/).map(Number);
  return fm !== tm || fn !== tn;
}

export interface MergeResult {
  copied: string[];
  overwritten: string[];
  /** Edited by the user: the new version was written beside it as `<file>.new`. */
  conflicts: string[];
  hashes: Record<string, string>;
}

/**
 * Brings the install folder's guidelines up to the shipped ones. A file the user did not edit (its hash equals the recorded shipped hash)
 * is overwritten; an edited one gets a `.new` file beside it; a missing one is copied. Files removed upstream are left in place.
 */
export function mergeGuidelines(assets: string, dir: string, recorded: Record<string, string>): MergeResult {
  const shipped = shippedGuidelineHashes(assets);
  const result: MergeResult = { copied: [], overwritten: [], conflicts: [], hashes: { ...recorded } };
  for (const [rel, newHash] of Object.entries(shipped)) {
    const source = path.join(assets, rel);
    const target = path.join(dir, rel);
    if (!existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
      result.copied.push(rel);
      result.hashes[rel] = newHash;
      continue;
    }
    const localHash = sha256(readFileSync(target));
    if (localHash === newHash) {
      result.hashes[rel] = newHash;
    } else if (recorded[rel] !== undefined && localHash === recorded[rel]) {
      copyFileSync(source, target);
      result.overwritten.push(rel);
      result.hashes[rel] = newHash;
    } else {
      copyFileSync(source, `${target}.new`);
      result.conflicts.push(rel);
    }
  }
  return result;
}

/** `${KEY:?…}` variables the compose file requires. */
export function requiredKeys(composeText: string): string[] {
  return [...new Set([...composeText.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)].map((m) => m[1] as string))];
}

const GENERATORS: Record<string, () => string> = {
  POSTGRES_PASSWORD: generatePostgresPassword,
  ENCRYPTION_KEY: generateEncryptionKey,
  SETUP_CODE: generateSetupCode,
};

/** Adds the required keys that .env lacks (generating secrets); returns the new text, what was added and what could not be filled. */
export function addMissingKeys(envText: string, composeText: string): { text: string; added: string[]; unknown: string[] } {
  let text = envText;
  const added: string[] = [];
  const unknown: string[] = [];
  for (const key of requiredKeys(composeText)) {
    if (getEnv(text, key)) continue;
    const gen = GENERATORS[key];
    if (gen) {
      text = setEnv(text, key, gen());
      added.push(key);
    } else unknown.push(key);
  }
  return { text, added, unknown };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

async function backup(dir: string, version: string): Promise<string> {
  const file = path.join(dir, 'backups', `sdlc-${version}-${stamp()}.sql.gz`);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const child = spawn('docker', composeArgs(dir, ['exec', '-T', 'postgres', 'pg_dump', '-U', 'sdlc', 'sdlc']), { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
  const exited = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? 1)));
  const dump = createWriteStream(file, { mode: 0o600 });
  await pipeline(child.stdout, createGzip(), dump);
  if ((await exited) !== 0) throw new CliError(`The database backup failed: ${stderr.trim().split('\n').pop() ?? 'pg_dump error'}. Use --skip-backup to upgrade without one.`);
  chmodSync(file, 0o600);
  return file;
}

export interface UpgradeOptions {
  dir: string;
  yes: boolean;
  skipBackup: boolean;
}

export async function upgrade(opts: UpgradeOptions): Promise<void> {
  const { dir } = opts;
  const manifest = readManifest(dir);
  const envFile = path.join(dir, '.env');
  if (!manifest || !existsSync(envFile)) throw new CliError(`No installation found at ${dir}. Run \`sdlc-agent init\` first.`);
  const to = packageVersion();
  const cmp = compareSemver(to, manifest.version);
  if (cmp === 0) return void out(`Already on ${to}.`);
  if (cmp < 0) throw new CliError(`Downgrades are not supported (installed ${manifest.version}, this CLI is ${to}).`);

  const assets = assetsDir();
  const sections = sliceChangelog(readFileSync(path.join(assets, 'CHANGELOG.md'), 'utf8'), manifest.version, to);
  out(`Upgrading ${manifest.version} → ${to}`);
  for (const s of sections) out(`\n## ${s.version}\n${s.text.trim()}`);
  if (needsConfirmation(manifest.version, to, sections) && !opts.yes && !(await confirm('\nThis upgrade may contain breaking changes. Continue?'))) {
    throw new CliError('Cancelled.');
  }

  const doctor = await runDoctor({ dir, env: envFor(dir) }, true);
  if (!doctor.ok) throw new CliError('Fix the checks marked ✖ above, then try again.');

  if (!opts.skipBackup) {
    if (await isRunning(dir)) {
      const file = await backup(dir, manifest.version);
      out(`Database backup written to ${file}`);
    } else out(yellow('The stack is not running, so there is no database backup. Start it first, or pass --skip-backup.'));
  }

  const composeText = readFileSync(path.join(assets, 'docker-compose.yml'), 'utf8');
  copyFileSync(path.join(assets, 'docker-compose.yml'), path.join(dir, 'docker-compose.yml'));
  const merged = mergeGuidelines(assets, dir, manifest.guidelineHashes);

  let env = setEnv(readFileSync(envFile, 'utf8'), 'SDLC_VERSION', to);
  const keys = addMissingKeys(env, composeText);
  env = keys.text;
  writeEnvFile(envFile, env);
  for (const k of keys.unknown) out(yellow(`The new compose file needs ${k} in .env; please set it.`));

  const next: Manifest = { version: to, installedAt: manifest.installedAt, guidelineHashes: merged.hashes };
  writeManifest(dir, next);
  await up({ dir, quiet: true });

  out(`\nUpgraded to ${to}.`);
  if (merged.conflicts.length > 0) {
    out('You edited these guidelines; the new versions were written beside them. Review and merge:');
    for (const f of merged.conflicts) out(`  ${path.join(dir, f)}.new`);
  }
}
