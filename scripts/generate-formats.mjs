// Writes guidelines/formats/<name>.md from the defaults in packages/shared (build the package first). Overwrites: run it to reset every format.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORMATS, formatPath } from '../packages/shared/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../guidelines');
mkdirSync(path.join(root, 'formats'), { recursive: true });
for (const f of FORMATS) writeFileSync(path.join(root, formatPath(f.name)), f.default);
console.log(`${FORMATS.length} format files written`);
