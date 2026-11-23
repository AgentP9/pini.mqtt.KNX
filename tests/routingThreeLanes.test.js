'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../public/routing.html'), 'utf8');

test('routing designer provides KNX, logic and MQTT lanes', () => {
  for (const id of ['devices', 'logic', 'mqtt']) assert.match(html, new RegExp('<section id="'+id+'"'));
  assert.match(html, /grid-template-columns:minmax\(240px,1fr\) minmax\(220px,\.8fr\) minmax\(240px,1fr\)/);
});
test('add forms live only in add dialog, not in right sidebar', () => {
  assert.match(html, /id="routing-add-dialog"/);
  for (const id of ['mqtt-signal-form','endpoint-form','open-mqtt-device']) {
    assert.equal(html.split('id="'+id+'"').length - 1, 1);
  }
  assert.doesNotMatch(html, /<aside class="col-12 col-xl-3">/);
});
test('logic blocks are loaded from backend and updated by socket', () => {
  assert.match(html, /fetch\('\/api\/logic\/staircase'/);
  assert.match(html, /socket\.on\('staircase'/);
  assert.match(html, /logicBlocks\.filter/);
});

test('logic is configured on existing routes instead of standalone', () => {
  assert.match(html, /route-logic-action/);
  assert.match(html, /id="route-logic-dialog"/);
  assert.match(html, /routeId:editingLogicRoute/);
  assert.match(html, /logicBlocks.find\(b=>b.routeId===r.id\)/);
  assert.match(html, /Bitte zuerst die Verbindungsänderungen aktivieren/);
});
