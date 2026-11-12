#!/usr/bin/env bash
# Prepares a release: sets the version in every workspace, refreshes the lockfile, and turns the changelog's
# "Unreleased" section into the new version. Then commit, and tag with `git tag vX.Y.Z`.
# Usage: scripts/bump-version.sh X.Y.Z[-rc.N]
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=${1:-}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "Usage: $0 X.Y.Z (for example 0.0.1 or 0.0.2-rc.1)"; exit 1; }
grep -q '^## \[Unreleased\]' CHANGELOG.md || { echo "CHANGELOG.md has no '## [Unreleased]' section"; exit 1; }
! grep -q "^## \[$VERSION\]" CHANGELOG.md || { echo "CHANGELOG.md already has a section for $VERSION"; exit 1; }

PREVIOUS=$(node -p "require('./package.json').version")
TODAY=$(date +%Y-%m-%d)

for pkg in package.json apps/*/package.json packages/*/package.json; do
  # Replace only the top-level "version" line so the file keeps its formatting.
  node -e "
    const fs = require('fs');
    const [file, version] = process.argv.slice(1);
    const text = fs.readFileSync(file, 'utf8');
    const next = text.replace(/^(\\s*\"version\": \")[^\"]*(\")/m, '\$1' + version + '\$2');
    if (next === text && JSON.parse(text).version !== version) { console.error('no version line in ' + file); process.exit(1); }
    fs.writeFileSync(file, next);
  " "$pkg" "$VERSION"
done
npm install --package-lock-only >/dev/null

# Changelog: Unreleased -> the new version, a fresh empty Unreleased above it, and the compare links updated.
node -e "
  const fs = require('fs');
  const [version, previous, today] = process.argv.slice(1);
  let text = fs.readFileSync('CHANGELOG.md', 'utf8');
  text = text.replace('## [Unreleased]', '## [Unreleased]\n\n## [' + version + '] - ' + today);
  const repo = 'https://github.com/pjx16/sdlc-agentic-workflow';
  text = text.replace(/^\[Unreleased\]: .*\$/m, '[Unreleased]: ' + repo + '/compare/v' + version + '...HEAD');
  const link = '[' + version + ']: ' + repo + '/compare/v' + previous + '...v' + version;
  text = text.replace(/^(\[Unreleased\]: .*)\$/m, '\$1\n' + link);
  fs.writeFileSync('CHANGELOG.md', text);
" "$VERSION" "$PREVIOUS" "$TODAY"

echo "Version set to $VERSION (was $PREVIOUS). Review the changes, commit them, then: git tag v$VERSION"
