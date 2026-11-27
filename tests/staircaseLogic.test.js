'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const StaircaseLogic = require('../src/staircaseLogic');

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staircase-'));
  const sent = [];
  let clock = 1000;
  let jobs = [];
  const logic = new StaircaseLogic({
    file: path.join(dir, 'logic.json'),
    writeKnx: (address, value) => { sent.push(['knx', address, value]); return true; },
    publishMqtt: (topic, value) => { sent.push(['mqtt', topic, value]); return true; },
    now: () => clock,
    schedule: (fn, delay) => { const job = { fn, at: clock + delay, cancelled: false }; jobs.push(job); return job; },
    cancel: job => { job.cancelled = true; },
  });
  const advance = ms => {
    clock += ms;
    for (;;) {
      const due = jobs.find(j => !j.cancelled && !j.done && j.at <= clock);
      if (!due) break;
      due.done = true; due.fn();
    }
  };
  logic.bindRouting({
    groupAddresses: [{ address: '2/2/11', dpt: '5.001' }],
    routes: [{ id: 'route-flur', from: { type: 'device', id: 'knx' }, to: { type: 'mqtt', id: 'mqtt' } }],
    endpoints: [],
    resolve: ref => ref.type === 'device'
      ? { address: '1/0/7', type: 'boolean' }
      : { topic: 'home/light', type: 'boolean' },
  });
  const cleanup = () => { logic.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { logic, sent, advance, cleanup, file: path.join(dir, 'logic.json') };
}
const block = { routeId: 'route-flur', name: 'Flur', durationSeconds: 10, enabled: true, input: { type: 'knx', value: '1/0/7' }, output: { type: 'knx', value: '1/0/8' } };

test('ON cancels timer; repeated OFF restarts delay', () => {
  const h = harness();
  try {
    h.logic.save(block);
    h.logic.onRoute('route-flur', 'ON');
    h.advance(20000);
    assert.equal(h.logic.list()[0].active, false);
    h.logic.onRoute('route-flur', 'OFF');
    h.advance(9000);
    h.logic.onRoute('route-flur', 'OFF');
    h.advance(9000);
    assert.deepEqual(h.sent, [['mqtt','home/light','ON']]);
    h.advance(1000);
    assert.deepEqual(h.sent.at(-1), ['mqtt','home/light','OFF']);
    assert.equal(h.sent.length, 2);
  } finally { h.cleanup(); }
});
test('disabled blocks, unrelated inputs and unsupported MQTT payloads do not trigger', () => {
  const h = harness();
  try {
    h.logic.save({ ...block, enabled: false });
    h.logic.onRoute('route-flur', 'ON');
    h.logic.trigger('knx', '1/0/9', 'OFF');
    assert.equal(h.sent.length, 0);
    h.logic.save({ ...block, enabled: true }, h.logic.list()[0].id);
    h.logic.onRoute('route-flur', 'garbage');
    assert.equal(h.sent.length, 0);
    h.logic.onRoute('route-flur', '0');
    assert.equal(h.sent.length, 0);
    assert.equal(h.logic.list()[0].active, true);
    assert.deepEqual(h.logic.mqttTopics(), []);
  } finally { h.cleanup(); }
});
test('configuration persists; editing and deletion cancel pending timers', () => {
  const h = harness();
  try {
    const saved = h.logic.save(block);
    assert.equal(JSON.parse(fs.readFileSync(h.file)).blocks.length, 1);
    h.logic.onRoute('route-flur', 'ON');
    h.logic.onRoute('route-flur', 'OFF');
    h.logic.save({ ...block, durationSeconds: 20 }, saved.id);
    h.advance(11000);
    assert.equal(h.sent.length, 1);
    h.logic.onRoute('route-flur', 'ON');
    h.logic.onRoute('route-flur', 'OFF');
    h.logic.remove(saved.id);
    h.advance(21000);
    assert.equal(h.sent.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(h.file)).blocks.length, 0);
  } finally { h.cleanup(); }
});
test('reject feedback loops and invalid duration', () => {
  const h = harness();
  try {
    assert.throws(() => h.logic.save({ ...block, routeId: 'missing' }), /Connection does not exist/);
    assert.throws(() => h.logic.save({ ...block, durationSeconds: 0 }), /Duration/);
    assert.throws(() => h.logic.save({ ...block, routeId: null }), /Select an existing connection/);
  } finally { h.cleanup(); }
});

test('dimmer sends DPT5.001 percentage instead of switch ON, but still switches OFF on expiry', () => {
  const h = harness();
  try {
    h.logic.save({ ...block, dimmer: { enabled: true, address: '2/2/11', percent: 80 } });
    h.logic.onRoute('route-flur', 'ON');
    assert.deepEqual(h.sent, [['knx', '2/2/11', '80']]);
    h.advance(5000);
    h.logic.onRoute('route-flur', 'OFF');
    assert.equal(h.sent.length, 1);
    h.advance(9999);
    assert.equal(h.sent.length, 1);
    h.advance(1);
    assert.deepEqual(h.sent[1], ['mqtt', 'home/light', 'OFF']);
  } finally { h.cleanup(); }
});
test('dimmer rejects invalid levels and non-DPT5.001 group addresses', () => {
  const h = harness();
  try {
    assert.throws(() => h.logic.save({ ...block, dimmer: { enabled: true, address: '2/2/11', percent: 101 } }), /1–100/);
    assert.throws(() => h.logic.save({ ...block, dimmer: { enabled: true, address: '1/0/7', percent: 50 } }), /Dimmer address/);
  } finally { h.cleanup(); }
});

test('ON during countdown cancels OFF including boolean aliases', () => {
 const h = harness();
 try {
  h.logic.save(block);
  h.logic.onRoute('route-flur', true);
  h.logic.onRoute('route-flur', false);
  h.advance(9000);
  h.logic.onRoute('route-flur', '1');
  assert.equal(h.logic.list()[0].active, false);
  h.advance(20000);
  assert.deepEqual(h.sent, [['mqtt','home/light','ON'],['mqtt','home/light','ON']]);
 } finally { h.cleanup(); }
});

test('external enable blocks triggers until ON, cancels delay and sends immediate OFF', () => {
 const h=harness();
 try {
  h.logic.save({...block,enableInput:{type:'mqtt',value:'home/enable'}});
  assert.ok(h.logic.mqttTopics().includes('home/enable'));
  assert.equal(h.logic.onRoute('route-flur','ON'),true);
  assert.equal(h.sent.length,0);
  h.logic.trigger('mqtt','home/enable','ON');
  h.logic.onRoute('route-flur','ON');
  h.logic.onRoute('route-flur','OFF');
  h.logic.trigger('mqtt','home/enable','OFF');
  assert.equal(h.logic.list()[0].released,false);
  assert.equal(h.logic.list()[0].active,false);
  h.logic.onRoute('route-flur','ON');
  h.logic.onRoute('route-flur','OFF');
  h.advance(20000);
  assert.deepEqual(h.sent,[['mqtt','home/light','ON'],['mqtt','home/light','OFF']]);
  h.logic.trigger('mqtt','home/enable','ON');
  h.logic.onRoute('route-flur','ON');
  assert.equal(h.sent.at(-1)[2],'ON');
 } finally {h.cleanup();}
});

test('KNX enable accepts DPT 1.001 and 1.002 with TRUE/FALSE semantics', () => {
 for (const dpt of ['1.001','1.002']) {
  const h=harness();
  try {
   h.logic.routingStore.groupAddresses.push({address:'1/0/9',dpt});
   h.logic.save({...block,enableInput:{type:'knx',value:'1/0/9'}});
   h.logic.trigger('knx','1/0/9','TRUE');
   h.logic.onRoute('route-flur','ON');
   h.logic.onRoute('route-flur','OFF');
   h.logic.trigger('knx','1/0/9','FALSE');
   h.advance(20000);
   h.logic.onRoute('route-flur','ON');
   assert.deepEqual(h.sent,[['mqtt','home/light','ON'],['mqtt','home/light','OFF']]);
   assert.equal(h.logic.list()[0].released,false);
  } finally {h.cleanup();}
 }
});
