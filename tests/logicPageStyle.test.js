'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../public/logic.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/logic.css'), 'utf8');

test('logic page uses shared shell, Bootstrap grid and panel design', () => {
  assert.match(html, /href="\/app-shell\.css"/);
  assert.match(html, /class="app-page-head"/);
  assert.match(html, /id="blocks" class="row g-3"/);
  assert.match(html, /class="col-12 col-xl-6"/);
  assert.match(html, /class="app-panel logic-card h-100"/);
  assert.match(html, /class="badge rounded-pill/);
  assert.match(css, /var\(--bs-tertiary-bg\)/);
});
test('existing live status and editing behavior remain available', () => {
  for (const id of ['block-count','message','editor','form','duration','enabled']) assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(html, /socket\.on\('staircase'/);
  assert.match(html, /data-remaining/);
  assert.match(html, /data-edit/);
  assert.match(html, /data-delete/);
  assert.match(html, /href="\/routing\.html"/);
});
test('hidden route endpoints do not prevent submitting the editor', () => {
  assert.doesNotMatch(html, /id="input-value"[^>]*required/);
  assert.doesNotMatch(html, /id="output-value"[^>]*required/);
});
