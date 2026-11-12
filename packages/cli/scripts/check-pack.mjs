// CI guard: the npm tarball may contain only dist/, assets/, README.md, LICENSE and package.json, and nothing that looks like a secret or a test.
// Usage: npm pack -w sdlc-agent --json --dry-run | node packages/cli/scripts/check-pack.mjs
import { readFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync(0, 'utf8'));
const entry = Array.isArray(raw) ? raw[0] : Object.values(raw)[0];
const allowed = /^(dist\/|assets\/|README\.md$|LICENSE$|package\.json$)/;
const forbidden = /\.env$|\.pem$|\.key$|node_modules|\.test\./;

const bad = entry.files.map((f) => f.path).filter((p) => !allowed.test(p) || forbidden.test(p));
if (bad.length > 0) {
  console.error(`Unexpected files in the package:\n${bad.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Package contents OK (${entry.files.length} files)`);
