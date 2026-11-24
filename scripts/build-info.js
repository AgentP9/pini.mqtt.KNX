'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
  }).trim();
}

const output = process.argv[2];
const repository = process.argv[3];
const expectedBranch = process.argv[4];
const expectedCommit = process.argv[5];
if (!output || !repository || !expectedBranch || !/^[0-9a-f]{40}$/.test(expectedCommit || '')) {
  throw new Error('Build info needs output, repository, branch and immutable commit');
}

// Only the inputs copied into the image identify its source. Never rely on
// Portainer's Docker context containing .git (it does not).
const inputs = ['package.json', 'package-lock.json', 'src', 'public', 'config', 'scripts/build-info.js'];
const files = new Map();
function addFile(file) {
  if (file === 'public/build-info.json') return;
  const details = fs.lstatSync(file);
  if (!details.isFile()) throw new Error(`Unexpected build input type: ${file}`);
  files.set(file, git(['hash-object', '--', file]));
}
function visit(file) {
  if (!fs.existsSync(file)) return;
  if (fs.lstatSync(file).isDirectory()) {
    for (const child of fs.readdirSync(file)) visit(path.posix.join(file, child));
  } else {
    addFile(file);
  }
}
for (const input of inputs) visit(input);
if (!files.size) throw new Error('Build source has no application files');

// Git metadata lives in a disposable temp dir, not the build context or an
// image layer. The remote branch/SHA are accepted only if EVERY copied input
// (names and Git blob hashes) matches exactly one remote commit.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-git-'));
try {
  const bare = path.join(temp, 'source.git');
  git(['clone', '--bare', '--depth=1', '--no-single-branch', '--quiet', '--', repository, bare]);
  const fromBare = (...args) => git(['--git-dir', bare, ...args]);
  const refs = fromBare('for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').filter(Boolean);
  const matches = [];
  for (const ref of refs) {
    const rows = fromBare('ls-tree', '-r', '-z', ref, '--', ...inputs)
      .split('\0').filter(Boolean);
    const tracked = new Map(rows.map(row => {
      const match = row.match(/^100644 blob ([0-9a-f]{40})\t(.+)$/);
      if (!match) throw new Error(`Unexpected remote build input: ${row}`);
      return [match[2], match[1]];
    }));
    if (tracked.size !== files.size ||
        [...files].some(([file, hash]) => tracked.get(file) !== hash)) continue;
    matches.push({ branch: ref.slice('refs/heads/'.length), commit: fromBare('rev-parse', ref) });
  }
  if (matches.length !== 1 || matches[0].branch !== expectedBranch ||
      matches[0].commit !== expectedCommit) {
    throw new Error('Build source does not match the expected remote branch and commit');
  }
  const { branch, commit } = matches[0];
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Build needs a Git commit');
  fs.writeFileSync(output, JSON.stringify({
    branch, commit, shortSha: commit.slice(0, 12), builtAt: new Date().toISOString(),
  }) + '\n');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
