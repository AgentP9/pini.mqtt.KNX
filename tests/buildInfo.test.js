'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const generator = path.join(__dirname, '../scripts/build-info.js');

test('Docker build uses scoped source and temporary read-only Git metadata', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '../Dockerfile'), 'utf8');
  const ignore = fs.readFileSync(path.join(__dirname, '../.dockerignore'), 'utf8');
  const compose = fs.readFileSync(path.join(__dirname, '../docker-compose.yml'), 'utf8');
  assert.doesNotMatch(dockerfile, /^COPY \. \.\/?$/m);
  assert.match(dockerfile, /COPY src\/ \.\/src\//);
  assert.match(dockerfile, /RUN --mount=type=bind,source=\.git,target=\/app\/\.git,readonly node scripts\/build-info\.js public\/build-info\.json/);
  assert.match(compose, /pull_policy: build/);
  assert.doesNotMatch(ignore, /^\.git\s*$/m);
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
  fs.symlinkSync(path.join(repo, '.git'), path.join(build, '.git'), 'dir');
  const output = path.join(build, 'public/build-info.json');
  execFileSync(process.execPath, [generator, output], { cwd: build });
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).commit, git('rev-parse', 'HEAD'));
  fs.writeFileSync(path.join(build, 'src/app.js'), 'module.exports = false;\n');
  assert.throws(() => execFileSync(process.execPath, [generator, output], { cwd: build, stdio: 'pipe' }), /Command failed/);
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
  assert.throws(() => execFileSync(process.execPath, [generator, path.join(repo, 'build-info.json')],
                                   { cwd: repo, stdio: 'pipe' }), /Command failed/);
  assert.equal(fs.existsSync(path.join(repo, 'build-info.json')), false);
});

test('detached Git checkout resolves its unique branch ref', (t) => {
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
  git('checkout', '--detach', '-q', 'HEAD');
  const output = path.join(repo, 'build-info.json');
  execFileSync(process.execPath, [generator, output], { cwd: repo });
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).branch, 'feature/build-information');
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
  execFileSync(process.execPath, [generator, output], { cwd: repo });
  const info = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(info.branch, 'feature/build-information');
  assert.equal(info.commit, commit);
  assert.equal(info.shortSha, commit.slice(0, 12));
  assert.ok(Date.parse(info.builtAt) >= start && Date.parse(info.builtAt) <= Date.now());
});
