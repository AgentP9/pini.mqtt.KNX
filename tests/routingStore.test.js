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
    { address: '9/1/0', dpt: '1.001' },
    { address: '9/1/1', dpt: '1.011' },
  ];
  const devices = [{ id: 'd1', name: 'Dining', templateId: 'switch', addresses: { command: '9/1/0', status: '9/1/1' } }];
  const deviceStore = { file: path.join(dir, 'devices.json'), devices, templates: () => [{ id: 'switch', objects: [{ key: 'command', dpt: '1.001' }, { key: 'status', dpt: '1.011' }] }] };
  const store = new RoutingStore(deviceStore, gas, path.join(dir, 'routing.json'));
  const endpoint = { id: 'm1', name: 'Dining status', topic: 'home/dining/status', payloadType: 'boolean' };
  return { dir, gas, devices, store, endpoint, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
test('persists a validated device feedback route without modifying group addresses', () => {
  const f = fixture();
  try {
    const old = JSON.stringify(f.gas);
    f.store.save({ endpoints: [f.endpoint], routes: [{ id: 'r1', from: { type: 'device', id: 'd1', signal: 'status' }, to: { type: 'mqtt', id: 'm1' }, enabled: true }] });
    assert.equal(f.store.routes.length, 1);
    assert.equal(JSON.stringify(f.gas), old);
    assert.equal(JSON.parse(fs.readFileSync(f.store.file, 'utf8')).version, 3);
  } finally { f.cleanup(); }
});
test('accepts graph-defined direction independently of KNX object roles', () => {
 const f=fixture();
 try {
  const mqtt={type:'mqtt',id:'m1'};
  const status={type:'device',id:'d1',signal:'status'};
  f.store.save({endpoints:[f.endpoint],routes:[{id:'r1',from:mqtt,to:status,enabled:true}]});
  assert.equal(f.store.routes[0].from.type,'mqtt');
 } finally {f.cleanup();}
});
test('rejects incompatible payload types but ignores obsolete GA routing metadata', () => {
  const f = fixture();
  try {
    const from = { type: 'device', id: 'd1', signal: 'status' };
    const to = { type: 'mqtt', id: 'm1' };
    assert.throws(() => f.store.save({ endpoints: [{ ...f.endpoint, payloadType: 'text' }], routes: [{ id: 'r1', from, to, enabled: true }] }), /Signal types/);
    f.gas[1].routes = [{ mqttTopic: f.endpoint.topic }];
    f.store.save({ endpoints: [f.endpoint], routes: [{ id: 'r1', from, to, enabled: true }] });
    assert.equal(f.store.routes.length, 1);
  } finally { f.cleanup(); }
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
  f.store.save({endpoints:[],mqttDevices:[md],routes:[{
   id:'r2',from:{type:'mqttDevice',id:'sonos1',signal:'control'},to:{type:'device',id:'d1',signal:'command'},enabled:true,transform:{kind:'map',values:{PLAY:'ON'}}}]});
  assert.equal(f.store.routes[0].from.type,'mqttDevice');
 } finally {f.cleanup();}
});

test('rejects duplicate topics across MQTT devices and standalone endpoints', () => {
 const f=fixture();
 try {
  const signal={key:'control',label:'Control',topic:f.endpoint.topic,payloadType:'boolean',direction:'input'};
  const md={id:'sonos1',name:'Sonos Dining',templateId:'sonos',signals:[signal]};
  assert.throws(()=>f.store.save({endpoints:[f.endpoint],mqttDevices:[md],routes:[]}),/Invalid MQTT device signal/);
  assert.throws(()=>f.store.save({endpoints:[],mqttDevices:[md,{...md,id:'sonos2',name:'Sonos Two'}],routes:[]}),/Invalid MQTT device signal/);
 } finally { f.cleanup(); }
});
test('supports Sonos state feedback with default OFF mapping', () => {
 const f=fixture();
 try {
  const md={id:'sonos1',name:'Sonos Dining',templateId:'sonos',signals:[{key:'state',label:'Wiedergabestatus',topic:'sonos/devices/Dining/state',payloadType:'text',direction:'output'}]};
  const route={id:'state-to-knx',from:{type:'mqttDevice',id:'sonos1',signal:'state'},to:{type:'device',id:'d1',signal:'command'},enabled:true,transform:{kind:'map',values:{PLAYING:'ON'},defaultValue:'OFF'}};
  f.store.save({endpoints:[],mqttDevices:[md],routes:[route]});
  assert.equal(f.store.routes[0].transform.defaultValue,'OFF');
 } finally {f.cleanup()}
});
test('disabled MQTT channels persist while their routes remain present but inactive', () => {
 const f=fixture();
 try {
  const md={id:'mqtt1',name:'Dining',templateId:'custom',signals:[
   {key:'power',label:'Power',topic:'home/dining/power',payloadType:'boolean',direction:'input',enabled:true},
   {key:'dimming',label:'Dimming',topic:'home/dining/dimming',payloadType:'boolean',direction:'input',enabled:false}
  ]};
  const from={type:'device',id:'d1',signal:'command'};
  const route={id:'r1',from,to:{type:'mqttDevice',id:'mqtt1',signal:'dimming'},enabled:false,suspendedByChannel:true};
  f.store.save({endpoints:[],mqttDevices:[md],routes:[route]});
  assert.equal(f.store.resolve(route.to,[]).enabled,false);
  assert.equal(f.store.routes[0].enabled,false);
  assert.equal(JSON.parse(fs.readFileSync(f.store.file,'utf8')).mqttDevices[0].signals[1].enabled,false);
  assert.throws(()=>f.store.save({endpoints:[],mqttDevices:[md],routes:[{...route,enabled:true}]}),/disabled MQTT channel/);
  assert.throws(()=>f.store.save({endpoints:[],mqttDevices:[{...md,signals:[{...md.signals[0],enabled:'false'},md.signals[1]]}],routes:[]}),/Invalid MQTT device signal/);
  f.store.save({endpoints:[],mqttDevices:[{...md,signals:md.signals.map(x=>({...x,enabled:true}))}],routes:[{...route,enabled:true,suspendedByChannel:undefined}]});
  assert.equal(f.store.routes[0].enabled,true);
 } finally {f.cleanup()}
});


test('routing direction is defined by graph, not group-address metadata', () => {
 const f=fixture();
 try {
  f.gas[0].direction='knx2mqtt';
  const route={id:'r1',from:{type:'mqtt',id:'m1'},to:{type:'device',id:'d1',signal:'command'},enabled:true};
  f.store.save({endpoints:[f.endpoint],routes:[route]});
  assert.equal(f.store.routes[0].to.type,'device');
  assert.equal(f.store.list().explicitKnxWrites,undefined);
  assert.equal(f.store.list().legacyCleaned,undefined);
 } finally {f.cleanup();}
});


test('numeric string mapping to number target is not a diagnostic conflict',()=>{
 const f=fixture();
 try {
  f.store.save({endpoints:[{...f.endpoint,payloadType:'number'}],routes:[{id:'numeric-map',from:{type:'device',id:'d1',signal:'command'},to:{type:'mqtt',id:'m1'},enabled:true,transform:{kind:'map',values:{ON:'20',OFF:'20'}}}]});
  assert.equal(f.store.diagnostics().length,0);
 } finally {f.cleanup();}
});

test('non-numeric string mapping to number target remains a diagnostic conflict',()=>{
 const f=fixture();
 try {
  f.store.save({endpoints:[{...f.endpoint,payloadType:'number'}],routes:[{id:'bad-map',from:{type:'device',id:'d1',signal:'command'},to:{type:'mqtt',id:'m1'},enabled:true,transform:{kind:'map',values:{ON:'PLAY',OFF:'PAUSE'}}}]});
  assert.match(f.store.diagnostics()[0].reasons.join(' '),/Ziel erwartet number/);
 } finally {f.cleanup();}
});


test('JSON boolean mapping with ON/OFF strings does not produce false type conflict',()=>{
 const f=fixture();
 try {
  const md={id:'shelly1',name:'Shelly',templateId:'generic',signals:[{key:'status',topic:'shelly/status',payloadType:'text',direction:'output'}]};
  f.store.save({endpoints:[],mqttDevices:[md],routes:[{id:'json-boolean',from:{type:'mqttDevice',id:'shelly1',signal:'status'},to:{type:'device',id:'d1',signal:'status'},enabled:true,transform:{kind:'json',path:'output',values:{true:'ON',false:'OFF'}}}]});
  assert.equal(f.store.diagnostics().length,0);
 } finally {f.cleanup();}
});

test('unrecognized boolean map output remains a diagnostic conflict',()=>{
 const f=fixture();
 try {
  f.store.save({endpoints:[{...f.endpoint,payloadType:'text'}],routes:[{id:'invalid-boolean',from:{type:'mqtt',id:'m1'},to:{type:'device',id:'d1',signal:'status'},enabled:true,transform:{kind:'map',values:{PLAY:'MAYBE'}}}]});
  assert.match(f.store.diagnostics()[0].reasons.join(' '),/Ziel erwartet boolean/);
 } finally {f.cleanup();}
});
