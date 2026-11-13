'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RoutingStore = require('../src/routingStore');
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-'));
  const gas = [
    { address: '9/1/0', dpt: '1.001', direction: 'both' },
    { address: '9/1/1', dpt: '1.011', direction: 'knx2mqtt' },
  ];
  const devices = [{ id: 'd1', name: 'Dining', templateId: 'switch', addresses: { command: '9/1/0', status: '9/1/1' } }];
  const deviceStore = { file: path.join(dir, 'devices.json'), devices, templates: () => [{ id: 'switch', objects: [{ key: 'command', dpt: '1.001' }, { key: 'status', dpt: '1.011' }] }] };
  const store = new RoutingStore(deviceStore, gas, path.join(dir, 'routing.json'));
  const endpoint = { id: 'm1', name: 'Dining status', topic: 'home/dining/status', payloadType: 'boolean' };
  return { dir, gas, devices, store, endpoint, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
test('persists a validated device feedback to MQTT connection without changing legacy GA config', () => {
  const f = fixture();
  try {
    const old = JSON.stringify(f.gas);
    f.store.save({ endpoints: [f.endpoint], routes: [{ id: 'r1', from: { type: 'device', id: 'd1', signal: 'status' }, to: { type: 'mqtt', id: 'm1' }, enabled: true }] });
    assert.equal(f.store.routes.length, 1);
    assert.equal(JSON.stringify(f.gas), old);
    assert.equal(JSON.parse(fs.readFileSync(f.store.file, 'utf8')).version, 2);
  } finally { f.cleanup(); }
});
test('rejects writes to read-only status and duplicate destination', () => {
  const f = fixture();
  try {
    const endpoint = f.endpoint;
    const command = { type: 'device', id: 'd1', signal: 'command' };
    const status = { type: 'device', id: 'd1', signal: 'status' };
    const mqtt = { type: 'mqtt', id: 'm1' };
    assert.throws(() => f.store.save({ endpoints: [endpoint], routes: [{ id: 'r1', from: mqtt, to: status, enabled: true }] }), /not writable/);
    assert.throws(() => f.store.save({ endpoints: [endpoint], routes: [{ id: 'r1', from: command, to: mqtt, enabled: true }, { id: 'r2', from: status, to: mqtt, enabled: true }] }), /Multiple routes/);
    assert.equal(f.store.routes.length, 0);
  } finally { f.cleanup(); }
});
test('rejects incompatible payload types and legacy route collisions', () => {
  const f = fixture();
  try {
    const from = { type: 'device', id: 'd1', signal: 'status' };
    const to = { type: 'mqtt', id: 'm1' };
    assert.throws(() => f.store.save({ endpoints: [{ ...f.endpoint, payloadType: 'text' }], routes: [{ id: 'r1', from, to, enabled: true }] }), /Signal types/);
    f.gas[1].routes = [{ mqttTopic: f.endpoint.topic }];
    assert.throws(() => f.store.save({ endpoints: [f.endpoint], routes: [{ id: 'r1', from, to, enabled: true }] }), /legacy/);
  } finally { f.cleanup(); }
});

test('migration previews both directions, preserves legacy config and avoids duplicate migration', () => {
  const f = fixture();
  try {
    f.gas[0].routes = [{ mqttTopic: 'home/dining/set' }];
    f.gas[1].routes = [{ mqttTopic: 'home/dining/status' }];
    const original = JSON.stringify(f.gas);
    const preview = f.store.migrationPreview();
    assert.equal(preview.candidates.length, 3);
    assert.equal(preview.skipped.length, 0);
    f.store.migrate(preview.candidates.map(c => c.key));
    assert.equal(f.store.routes.length, 3);
    assert.equal(JSON.stringify(f.gas), original);
    assert.equal(f.store.migrationPreview().candidates.length, 0);
    assert.equal(f.store.migrated('9/1/0', 'home/dining/set', 'mqtt2knx'), true);
    assert.equal(f.store.migrated('9/1/1', 'home/dining/status', 'knx2mqtt'), true);
    assert.throws(() => f.store.migrate(preview.candidates.map(c => c.key)), /outdated/);
  } finally { f.cleanup(); }
});
test('migration skips mappings and repeat intervals instead of silently changing semantics', () => {
  const f = fixture();
  try {
    f.gas[0].routes = [{ mqttTopic: 'home/dining/set', valueMap: { '1': 'ON' } }];
    f.gas[1].routes = [{ mqttTopic: 'home/dining/status', repeatInterval: 60 }];
    const preview = f.store.migrationPreview();
    assert.equal(preview.candidates.length, 1);
    assert.equal(preview.skipped.length, 2);
  } finally { f.cleanup(); }
});

test('migration groups Sonos topics as one MQTT device with independent mapped signals', () => {
 const f=fixture();
 try {
  f.gas[0].routes=[
   {mqttTopic:'sonos/devices/Esszimmer/control',valueMap:{ON:'PLAY',OFF:'PAUSE'}},
   {mqttTopic:'sonos/devices/Esszimmer/set/volume',valueMap:{ON:'20',OFF:'20'}}
  ];
  const preview=f.store.migrationPreview();
  const selected=preview.candidates.filter(c=>c.direction==='knx2mqtt');
  assert.equal(selected.length,2);
  assert.equal(selected[0].suggestedDevice.name,'Esszimmer');
  f.store.migrate(selected.map(c=>c.key));
  assert.equal(f.store.mqttDevices.length,1);
  assert.equal(f.store.mqttDevices[0].signals.length,2);
  assert.equal(f.store.routes.length,2);
  assert.equal(f.store.routes[0].transform.values.ON,'PLAY');
  assert.equal(f.store.migrated('9/1/0','sonos/devices/Esszimmer/control','knx2mqtt'),true);
 } finally {f.cleanup();}
});
test('validates standalone MQTT device signals and transformed routes',()=>{
 const f=fixture();
 try {
  const md={id:'sonos1',name:'Sonos Esszimmer',templateId:'sonos',signals:[
   {key:'control',label:'Wiedergabe',topic:'sonos/devices/Esszimmer/control',payloadType:'text',direction:'input'}]};
  f.store.save({endpoints:[],mqttDevices:[md],routes:[{
   id:'r1',from:{type:'device',id:'d1',signal:'command'},to:{type:'mqttDevice',id:'sonos1',signal:'control'},
   enabled:true,transform:{kind:'map',values:{ON:'PLAY',OFF:'PAUSE'}}}]});
  assert.equal(f.store.routes.length,1);
  assert.throws(()=>f.store.save({endpoints:[],mqttDevices:[md],routes:[{
   id:'r2',from:{type:'mqttDevice',id:'sonos1',signal:'control'},to:{type:'device',id:'d1',signal:'command'},enabled:true}]}),/not readable/);
 } finally {f.cleanup();}
});
