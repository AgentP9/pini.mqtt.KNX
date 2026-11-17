'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOpenHabExport, zip } = require('../src/openhabExport');

test('exports every configured MQTT topic and graph-defined directions', () => {
  const data = buildOpenHabExport({
    endpoints: [{ id: 'legacy', name: 'Unconnected', topic: 'free/topic', payloadType: 'text' }],
    mqttDevices: [{ id: 'd1', name: 'Living Room', signals: [
      { key: 'status', label: 'Status', topic: 'knx/status', payloadType: 'boolean' },
      { key: 'set', label: 'Setpoint', topic: 'knx/set', payloadType: 'number' }
    ] }],
    routes: [
      { id: 'r1', enabled: true, from: { type: 'device', id: 'knx', signal: 'status' }, to: { type: 'mqttDevice', id: 'd1', signal: 'status' } },
      { id: 'r2', enabled: true, from: { type: 'mqttDevice', id: 'd1', signal: 'set' }, to: { type: 'device', id: 'knx', signal: 'setpoint' } }
    ]
  });
  assert.equal(data.topicCount, 3);
  assert.match(data.files['knx-mqtt.things'], /stateTopic="knx\/status"/);
  assert.match(data.files['knx-mqtt.things'], /commandTopic="knx\/set"/);
  assert.doesNotMatch(data.files['knx-mqtt.things'], /stateTopic="knx\/set"/);
  assert.match(data.files['knx-mqtt.items'], /Switch Living_Room_Status/);
  assert.match(data.files['README.txt'], /free\/topic/);
});

test('exports reversible route as state and command topic', () => {
  const data = buildOpenHabExport({ endpoints: [{ id: 'm', name: 'Light', topic: 'light', payloadType: 'boolean' }], mqttDevices: [], routes: [{ id: 'r', enabled: true, bidirectional: true, from: { type: 'device', id: 'knx', signal: 'command' }, to: { type: 'mqtt', id: 'm' } }] });
  assert.match(data.files['knx-mqtt.things'], /stateTopic="light", commandTopic="light"/);
});

test('produces valid ZIP local and central headers', () => {
  const data = buildOpenHabExport({ endpoints: [], mqttDevices: [], routes: [] });
  const archive = zip(data.files);
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
  assert.equal(archive.readUInt16LE(archive.length - 12), 3);
});
