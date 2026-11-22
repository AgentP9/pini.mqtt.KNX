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
  const cleanup = () => { logic.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { logic, sent, advance, cleanup, file: path.join(dir, 'logic.json') };
}
const block = { name: 'Flur', durationSeconds: 10, enabled: true, input: { type: 'knx', value: '1/0/7' }, output: { type: 'knx', value: '1/0/8' } };

test('ON and OFF both restart timer; exactly one OFF after last trigger', () => {
  const h = harness();
  try {
    h.logic.save(block);
    h.logic.trigger('knx', '1/0/7', 'ON');
    h.advance(9000);
    h.logic.trigger('knx', '1/0/7', 'OFF');
    h.advance(9000);
    assert.deepEqual(h.sent, [['knx','1/0/8','ON'],['knx','1/0/8','ON']]);
    h.advance(1000);
    assert.deepEqual(h.sent.at(-1), ['knx','1/0/8','OFF']);
    assert.equal(h.sent.length, 3);
  } finally { h.cleanup(); }
});
test('disabled blocks, unrelated inputs and unsupported MQTT payloads do not trigger', () => {
  const h = harness();
  try {
    h.logic.save({ ...block, enabled: false });
    h.logic.trigger('knx', '1/0/7', 'ON');
    h.logic.trigger('knx', '1/0/9', 'OFF');
    assert.equal(h.sent.length, 0);
    h.logic.save({ ...block, input: { type: 'mqtt', value: 'home/trigger' }, output: { type: 'mqtt', value: 'home/light' } }, h.logic.list()[0].id);
    h.logic.trigger('mqtt', 'home/trigger', 'garbage');
    assert.equal(h.sent.length, 0);
    h.logic.trigger('mqtt', 'home/trigger', '0');
    assert.deepEqual(h.sent[0], ['mqtt', 'home/light', 'ON']);
    assert.deepEqual(h.logic.mqttTopics(), ['home/trigger']);
  } finally { h.cleanup(); }
});
test('configuration persists; editing and deletion cancel pending timers', () => {
  const h = harness();
  try {
    const saved = h.logic.save(block);
    assert.equal(JSON.parse(fs.readFileSync(h.file)).blocks.length, 1);
    h.logic.trigger('knx', '1/0/7', 'ON');
    h.logic.save({ ...block, durationSeconds: 20 }, saved.id);
    h.advance(11000);
    assert.equal(h.sent.length, 1);
    h.logic.trigger('knx', '1/0/7', 'ON');
    h.logic.remove(saved.id);
    h.advance(21000);
    assert.equal(h.sent.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(h.file)).blocks.length, 0);
  } finally { h.cleanup(); }
});
test('reject feedback loops and invalid duration', () => {
  const h = harness();
  try {
    assert.throws(() => h.logic.save({ ...block, output: block.input }), /differ/);
    assert.throws(() => h.logic.save({ ...block, durationSeconds: 0 }), /Duration/);
    assert.throws(() => h.logic.save({ ...block, input: { type: 'mqtt', value: 'invalid/#' } }), /Invalid endpoint/);
  } finally { h.cleanup(); }
});
