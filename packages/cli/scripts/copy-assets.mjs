// Copies what the CLI installs (the release compose file, guidelines, the Jira MCP example, the changelog and the licence)
// from the repository into packages/cli/assets before every build, so the package never drifts from the repo.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(pkg, '../..');
const assets = path.join(pkg, 'assets');

rmSync(assets, { recursive: true, force: true });
mkdirSync(path.join(assets, 'docker'), { recursive: true });

const copy = (from, to) => {
  const source = path.join(root, from);
  if (!existsSync(source)) throw new Error(`Missing ${from}; run this from a full checkout`);
  cpSync(source, path.join(assets, to), { recursive: true });
};
copy('deploy/docker-compose.yml', 'docker-compose.yml');
copy('guidelines', 'guidelines');
copy('CHANGELOG.md', 'CHANGELOG.md');
copy('LICENSE', 'LICENSE');
cpSync(path.join(root, 'LICENSE'), path.join(pkg, 'LICENSE'));
