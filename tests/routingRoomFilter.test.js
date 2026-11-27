'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { filterRoutingByRoom } = require('../public/routingRoomFilter');

const devices = [
  { id: 'living', roomId: 'room-a' },
  { id: 'hall', roomId: 'room-b' },
  { id: 'bedroom', roomId: 'room-b' },
  { id: 'loose' },
];
const routes = [
  { id: 'out', from: { type: 'device', id: 'living' }, to: { type: 'device', id: 'hall' } },
  { id: 'in', from: { type: 'device', id: 'bedroom' }, to: { type: 'device', id: 'living' } },
  { id: 'mqtt', from: { type: 'device', id: 'living' }, to: { type: 'mqttDevice', id: 'speaker' } },
  { id: 'elsewhere', from: { type: 'device', id: 'hall' }, to: { type: 'mqtt', id: 'other' } },
  { id: 'unassigned', from: { type: 'device', id: 'loose' }, to: { type: 'mqtt', id: 'loose-topic' } },
];

test('all rooms leaves every device and route available', () => {
  const view = filterRoutingByRoom(devices, routes, 'all');
  assert.deepEqual(view.routes, routes);
  assert.deepEqual([...view.deviceIds], devices.map(d => d.id));
});

test('selected room retains outgoing recipient and incoming source, but not unrelated routes', () => {
  const view = filterRoutingByRoom(devices, routes, 'room-a');
  assert.deepEqual(view.routes.map(r => r.id), ['out', 'in', 'mqtt']);
  assert.deepEqual([...view.deviceIds], ['living', 'hall', 'bedroom']);
  assert.deepEqual([...view.mqttIds], ['speaker']);
});

test('unassigned filter includes devices without a room and only their connections', () => {
  const view = filterRoutingByRoom(devices, routes, 'unassigned');
  assert.deepEqual([...view.deviceIds], ['loose']);
  assert.deepEqual(view.routes.map(r => r.id), ['unassigned']);
  assert.deepEqual([...view.mqttIds], ['loose-topic']);
});

test('a room with no routes still shows its devices', () => {
  const view = filterRoutingByRoom([{ id: 'alone', roomId: 'empty' }], routes, 'empty');
  assert.deepEqual([...view.deviceIds], ['alone']);
  assert.deepEqual(view.routes, []);
});

test('diagnostic focus clears a different room filter before rendering', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/routing.html'), 'utf8');
  const handler = html.slice(html.indexOf("$('routing-diagnostics').addEventListener('click'"), html.indexOf('function loadRoutingIssues'));
  assert.match(handler, /\$\('room-filter'\)\.value='all';\s*render\(\)/);
});
