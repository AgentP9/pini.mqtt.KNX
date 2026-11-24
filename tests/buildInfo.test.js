'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const generator = path.join(__dirname, '../scripts/build-info.js');

test('Docker build verifies scoped source against remote Git without context .git', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '../Dockerfile'), 'utf8');
  const ignore = fs.readFileSync(path.join(__dirname, '../.dockerignore'), 'utf8');
  const compose = fs.readFileSync(path.join(__dirname, '../docker-compose.yml'), 'utf8');
  assert.doesNotMatch(dockerfile, /^COPY \. \.\/?$/m);
  assert.match(dockerfile, /^COPY package\.json package-lock\.json \.\/$/m);
  assert.doesNotMatch(dockerfile, /^COPY package\*\.json/m);
  assert.match(dockerfile, /COPY src\/ \.\/src\//);
  assert.doesNotMatch(dockerfile, /source=\.git/);
  assert.match(dockerfile, /ARG BUILD_SOURCE_REPOSITORY=/);
  assert.match(dockerfile, /^ARG BUILD_SOURCE_BRANCH$/m);
  assert.match(dockerfile, /^ARG BUILD_SOURCE_COMMIT$/m);
  assert.match(dockerfile, /--mount=type=tmpfs,target=\/tmp\/build-info-git/);
  assert.match(dockerfile, /node scripts\/build-info\.js public\/build-info\.json\s*\\?\s*"\$BUILD_SOURCE_REPOSITORY" "\$BUILD_SOURCE_BRANCH" "\$BUILD_SOURCE_COMMIT"/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$BUILD_SOURCE_COMMIT"/);
  assert.match(compose, /image: knxmqtt-build-information:build-[0-9a-f]{16}\b/);
  assert.match(compose, /pull_policy: never/);
  assert.doesNotMatch(compose, /^\s+build:/m);
  assert.match(ignore, /^\.git\s*$/m);
  assert.match(ignore, /^\.env\s*$/m);
  assert.match(ignore, /^node_modules\s*$/m);
});

test('partial Docker build tree verifies copied source without requiring omitted docs', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'build-info-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const build = path.join(root, 'build');
  fs.mkdirSync(repo); fs.mkdirSync(build);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'feature/build-information');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(repo, 'src')); fs.mkdirSync(path.join(repo, 'public'));
  fs.writeFileSync(path.join(repo, 'src/app.js'), 'module.exports = true;\n');
  fs.writeFileSync(path.join(repo, 'public/index.html'), '<h1>App</h1>\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'not copied into image\n');
  git('add', '.'); git('commit', '-qm', 'source');
  fs.mkdirSync(path.join(build, 'src')); fs.mkdirSync(path.join(build, 'public'));
  fs.copyFileSync(path.join(repo, 'src/app.js'), path.join(build, 'src/app.js'));
  fs.copyFileSync(path.join(repo, 'public/index.html'), path.join(build, 'public/index.html'));
  // Simulate the real Portainer build context: no .git directory is supplied.
  assert.equal(fs.existsSync(path.join(build, '.git')), false);
  const output = path.join(build, 'public/build-info.json');
  const commit = git('rev-parse', 'HEAD');
  execFileSync(process.execPath, [generator, output, repo, 'feature/build-information', commit], { cwd: build });
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).commit, git('rev-parse', 'HEAD'));
  fs.writeFileSync(path.join(build, 'src/app.js'), 'module.exports = false;\n');
  assert.throws(() => execFileSync(process.execPath, [generator, output, repo, 'feature/build-information', commit],
                                   { cwd: build, stdio: 'pipe' }), /Command failed/);
});

test('build metadata rejects a source tree differing from its Git commit', (t) => {
  const repo = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'build-info-test-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'feature/build-information');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/source.txt'), 'committed source\n');
  git('add', 'src/source.txt');
  git('commit', '-qm', 'test source');
  fs.writeFileSync(path.join(repo, 'src/source.txt'), 'modified source\n');
  assert.throws(() => execFileSync(process.execPath, [generator, path.join(repo, 'build-info.json'), repo,
                                    'feature/build-information', git('rev-parse', 'HEAD')],
                                   { cwd: repo, stdio: 'pipe' }), /Command failed/);
  assert.equal(fs.existsSync(path.join(repo, 'build-info.json')), false);
});

test('ambiguous remote branches never invent a build branch', (t) => {
  const repo = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'build-info-test-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'feature/build-information');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/source.txt'), 'actual source\n');
  git('add', 'src/source.txt');
  git('commit', '-qm', 'test source');
  git('branch', 'feature/alias');
  const output = path.join(repo, 'build-info.json');
  assert.throws(() => execFileSync(process.execPath, [generator, output, repo,
                                    'feature/build-information', git('rev-parse', 'HEAD')],
                                   { cwd: repo, stdio: 'pipe' }), /Command failed/);
  assert.equal(fs.existsSync(output), false);
});

test('build metadata comes from the checked-out Git branch and commit', (t) => {
  const repo = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'build-info-test-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'feature/build-information');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/source.txt'), 'actual source\n');
  git('add', 'src/source.txt');
  git('commit', '-qm', 'test source');
  const commit = git('rev-parse', 'HEAD');
  const output = path.join(repo, 'build-info.json');
  const start = Date.now();
  execFileSync(process.execPath, [generator, output, repo, 'feature/build-information', commit], { cwd: repo });
  const info = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(info.branch, 'feature/build-information');
  assert.equal(info.commit, commit);
  assert.equal(info.shortSha, commit.slice(0, 12));
  assert.ok(Date.parse(info.builtAt) >= start && Date.parse(info.builtAt) <= Date.now());
  const wrongOutput = path.join(repo, 'invalid-build-info.json');
  for (const [branch, sha] of [
    ['feature/incorrect', commit],
    ['feature/build-information', '0'.repeat(40)],
  ]) {
    assert.throws(() => execFileSync(process.execPath,
      [generator, wrongOutput, repo, branch, sha], { cwd: repo, stdio: 'pipe' }), /Command failed/);
    assert.equal(fs.existsSync(wrongOutput), false);
  }
});

test('docs-only branch movement cannot relabel an older build context', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'build-info-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const build = path.join(root, 'build');
  fs.mkdirSync(repo); fs.mkdirSync(build);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'feature/build-information');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/app.js'), 'first source\n');
  git('add', '.'); git('commit', '-qm', 'first');
  const sourceCommit = git('rev-parse', 'HEAD');
  fs.mkdirSync(path.join(build, 'src'));
  fs.copyFileSync(path.join(repo, 'src/app.js'), path.join(build, 'src/app.js'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'docs only\n');
  git('add', '.'); git('commit', '-qm', 'docs only');
  const output = path.join(build, 'build-info.json');
  assert.throws(() => execFileSync(process.execPath, [generator, output, repo,
    'feature/build-information', sourceCommit], { cwd: build, stdio: 'pipe' }), /Command failed/);
  assert.equal(fs.existsSync(output), false);
});
