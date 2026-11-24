'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const output = process.argv[2];
if (!output) throw new Error('Build info output path required');
const commit = git('rev-parse', '--verify', 'HEAD');
const tracked = git('ls-files', '-z', '--', 'package.json', 'package-lock.json',
                    'src', 'public', 'config', 'scripts/build-info.js').split('\0').filter(Boolean);
if (!tracked.length) throw new Error('Build source has no tracked application files');
for (const file of tracked) {
  if (!fs.existsSync(file) || git('hash-object', '--', file) !== git('rev-parse', `HEAD:${file}`)) {
    throw new Error(`Build source differs from Git HEAD: ${file}`);
  }
}
let branch;
try {
  branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
} catch {
  const refs = git('for-each-ref', '--format=%(refname:short)', '--points-at', 'HEAD',
                   'refs/heads', 'refs/remotes/origin');
  const matches = [...new Set(refs.split('\n').filter(Boolean).map(ref => ref.replace(/^origin\//, '')))];
  if (matches.length !== 1) throw new Error('Cannot identify a unique Git branch for detached HEAD');
  branch = matches[0];
}
if (!/^[0-9a-f]{40}$/.test(commit) || !branch) throw new Error('Build needs a Git branch and commit');
fs.writeFileSync(output, JSON.stringify({
  branch,
  commit,
  shortSha: commit.slice(0, 12),
  builtAt: new Date().toISOString(),
}) + '\n');
