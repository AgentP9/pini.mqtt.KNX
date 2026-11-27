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
  assert.doesNotMatch(html, /route-logic-action/);
  assert.match(html, /id="route-logic-mode"/);
  assert.match(html, /routeId,name:/);
  assert.match(html, /logicBlocks.find\(b=>b.routeId===route.id\)/);
  assert.match(html, /Bitte zuerst Verbindungsänderungen aktivieren/);
});

test('staircase editor keeps JSON advanced and name optional to edit', () => {
 assert.match(html, /<details id="route-advanced"/);
 assert.match(html, /Weitere Optionen/);
 assert.match(html, /Einschalten über Dimmwert/);
});
test('enabled dimmer draws a dedicated branch to the DPT 5.001 signal', () => {
 assert.match(html, /logicBlock\.dimmer\.address/);
 assert.match(html, /stroke-dasharray/);
 assert.match(html, /connection-path has-logic/);
 assert.match(html, /connection-arrow has-logic/);
});
