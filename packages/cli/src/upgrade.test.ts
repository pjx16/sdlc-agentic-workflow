import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEnv } from './envfile';
import { sha256, shippedGuidelineHashes } from './manifest';
import { packageVersion } from './paths';
import { addMissingKeys, compareSemver, mergeGuidelines, needsConfirmation, requiredKeys, sliceChangelog, upgrade } from './upgrade';

const CHANGELOG = `# Changelog

## [Unreleased]

### Added
- not yet

## [0.0.2] - 2026-02-01

### Changed
- Breaking: renamed a setting.

## [0.0.1] - 2026-01-15

### Added
- a thing

## [0.0.0] - 2026-01-01

First.

[Unreleased]: https://example.com/compare
`;

describe('semver and changelog', () => {
  it('compares versions including release candidates', () => {
    expect(compareSemver('0.0.1', '0.0.0')).toBeGreaterThan(0);
    expect(compareSemver('0.0.2-rc.1', '0.0.2')).toBeLessThan(0);
    expect(compareSemver('0.0.2-rc.2', '0.0.2-rc.1')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });
  it('slices the sections after the installed version up to the new one, without Unreleased', () => {
    expect(sliceChangelog(CHANGELOG, '0.0.0', '0.0.2').map((s) => s.version)).toEqual(['0.0.2', '0.0.1']);
    expect(sliceChangelog(CHANGELOG, '0.0.1', '0.0.2').map((s) => s.version)).toEqual(['0.0.2']);
    expect(sliceChangelog(CHANGELOG, '0.0.0', '0.0.1')[0]?.text).toContain('a thing');
  });
  it('asks for confirmation on a "Breaking" note or a minor change during 0.x', () => {
    expect(needsConfirmation('0.0.0', '0.0.1', sliceChangelog(CHANGELOG, '0.0.0', '0.0.1'))).toBe(false);
    expect(needsConfirmation('0.0.1', '0.0.2', sliceChangelog(CHANGELOG, '0.0.1', '0.0.2'))).toBe(true);
    expect(needsConfirmation('0.0.5', '0.1.0', [])).toBe(true);
    expect(needsConfirmation('1.0.0', '2.0.0', [])).toBe(true);
  });
});

describe('guideline merge', () => {
  let assets: string;
  let dir: string;
  const write = (root: string, rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  beforeEach(() => {
    const base = mkdtempSync(path.join(tmpdir(), 'sdlc-merge-'));
    assets = path.join(base, 'assets');
    dir = path.join(base, 'inst');
    mkdirSync(dir);
  });
  afterEach(() => rmSync(path.dirname(assets), { recursive: true, force: true }));

  it('overwrites unedited files, writes .new beside edited ones, copies new ones, and leaves removed ones', () => {
    // What was shipped before:
    const old = { 'guidelines/same.md': 'same', 'guidelines/unedited.md': 'v1', 'guidelines/edited.md': 'v1', 'guidelines/removed.md': 'gone' };
    const recorded: Record<string, string> = {};
    for (const [rel, text] of Object.entries(old)) {
      write(dir, rel, text);
      recorded[rel] = sha256(text);
    }
    write(dir, 'guidelines/edited.md', 'my own edit');
    // What ships now:
    write(assets, 'guidelines/same.md', 'same');
    write(assets, 'guidelines/unedited.md', 'v2');
    write(assets, 'guidelines/edited.md', 'v2');
    write(assets, 'guidelines/new.md', 'brand new');

    const res = mergeGuidelines(assets, dir, recorded);
    expect(res.overwritten).toEqual(['guidelines/unedited.md']);
    expect(res.conflicts).toEqual(['guidelines/edited.md']);
    expect(res.copied).toEqual(['guidelines/new.md']);
    expect(readFileSync(path.join(dir, 'guidelines/unedited.md'), 'utf8')).toBe('v2');
    expect(readFileSync(path.join(dir, 'guidelines/edited.md'), 'utf8')).toBe('my own edit');
    expect(readFileSync(path.join(dir, 'guidelines/edited.md.new'), 'utf8')).toBe('v2');
    expect(readFileSync(path.join(dir, 'guidelines/new.md'), 'utf8')).toBe('brand new');
    expect(existsSync(path.join(dir, 'guidelines/removed.md'))).toBe(true);
    expect(res.hashes['guidelines/unedited.md']).toBe(shippedGuidelineHashes(assets)['guidelines/unedited.md']);
    expect(res.hashes['guidelines/edited.md']).toBe(sha256('v1')); // still the old shipped hash, so the next upgrade conflicts again
  });
});

describe('.env keys for a new compose file', () => {
  it('finds the required variables and generates the secrets that .env lacks', () => {
    const compose = 'a: ${POSTGRES_PASSWORD:?x}\nb: ${ENCRYPTION_KEY:?y}\nc: ${NEW_THING:?z}\nd: ${OPTIONAL:-}\n';
    expect(requiredKeys(compose)).toEqual(['POSTGRES_PASSWORD', 'ENCRYPTION_KEY', 'NEW_THING']);
    const res = addMissingKeys('POSTGRES_PASSWORD=keep\nOTHER=1\n', compose);
    expect(res.added).toEqual(['ENCRYPTION_KEY']);
    expect(res.unknown).toEqual(['NEW_THING']);
    expect(getEnv(res.text, 'POSTGRES_PASSWORD')).toBe('keep');
    expect(getEnv(res.text, 'OTHER')).toBe('1');
    expect(Buffer.from(getEnv(res.text, 'ENCRYPTION_KEY') as string, 'base64')).toHaveLength(32);
  });
});

describe('upgrade', () => {
  it('refuses a downgrade and does nothing when already on the version', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'sdlc-up-'));
    try {
      writeFileSync(path.join(base, '.env'), 'SDLC_VERSION=9.9.9\n');
      writeFileSync(path.join(base, '.sdlc-agent.json'), JSON.stringify({ version: '9.9.9', installedAt: 'x', guidelineHashes: {} }));
      await expect(upgrade({ dir: base, yes: true, skipBackup: true })).rejects.toThrow('Downgrades are not supported');
      writeFileSync(path.join(base, '.sdlc-agent.json'), JSON.stringify({ version: packageVersion(), installedAt: 'x', guidelineHashes: {} })); // the same version as this CLI
      await upgrade({ dir: base, yes: true, skipBackup: true }); // the same version as this CLI: returns
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

