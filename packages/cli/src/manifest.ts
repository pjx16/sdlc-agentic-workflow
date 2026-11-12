import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MANIFEST } from './paths';

export interface Manifest {
  version: string;
  installedAt: string;
  /** sha256 of each guideline file as it was shipped, by path relative to the install folder. */
  guidelineHashes: Record<string, string>;
}

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

export function readManifest(dir: string): Manifest | null {
  const file = path.join(dir, MANIFEST);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Manifest) : null;
}

export function writeManifest(dir: string, manifest: Manifest): void {
  writeFileSync(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Every file under `root`, as paths relative to `root` using forward slashes. */
export function listFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(root, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(path.join(root, r)).isDirectory()) out.push(...listFiles(root, r));
    else out.push(r);
  }
  return out;
}

/** sha256 of every shipped guideline file, keyed `guidelines/<path>`. */
export function shippedGuidelineHashes(assets: string): Record<string, string> {
  const root = path.join(assets, 'guidelines');
  return Object.fromEntries(listFiles(root).map((f) => [`guidelines/${f}`, sha256(readFileSync(path.join(root, f)))]));
}
