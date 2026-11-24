'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const shell = fs.readFileSync(path.join(__dirname, '../public/app-shell.js'), 'utf8');

test('shared shell shows the build branch, short SHA and build time without unsafe HTML', async () => {
  let ready;
  let requested;
  const nodes = [];
  const document = {
    documentElement: { setAttribute() {} },
    body: { appendChild(node) { nodes.push(node); } },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    createElement(tagName) { return { tagName, textContent: '', setAttribute() {} }; },
    addEventListener(event, callback) { if (event === 'DOMContentLoaded') ready = callback; },
  };
  const context = {
    document,
    localStorage: { getItem() { return null; } },
    window: { matchMedia() { return { matches: false }; }, addEventListener() {} },
    navigator: { userAgent: 'Test', maxTouchPoints: 0 },
    fetch(url, options) {
      requested = { url, options };
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        branch: 'feature/build-information', shortSha: 'deadbeefcafe',
        builtAt: '2026-11-24T12:00:00.000Z',
      }) });
    },
  };
  vm.runInNewContext(shell, context);
  ready();
  await new Promise(setImmediate);
  assert.equal(requested.url, '/build-info.json');
  assert.equal(requested.options.cache, 'no-store');
  assert.equal(nodes.length, 1);
  assert.match(nodes[0].textContent, /feature\/build-information/);
  assert.match(nodes[0].textContent, /deadbeefcafe/);
  assert.match(nodes[0].textContent, /2026/);
  assert.equal(nodes[0].innerHTML, undefined);
});
