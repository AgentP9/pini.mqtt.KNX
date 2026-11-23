'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const StaircaseLogic = require('../src/staircaseLogic');
const KnxHandler = require('../src/knxHandler');
const dptlib = require('knx/src/dptlib');

function harness(percent) {
  const sent = [];
  const scheduled = [];
  const groupAddresses = [{ address: '2/2/11', dpt: '5.001' }, { address: '1/0/8', dpt: '1.001' }];
  const knxHandler = {
    connected: true, groupAddresses, _recentWrites: new Set(),
    _findGA: KnxHandler.prototype._findGA,
    connection: { write(address, value, dpt) {
      const apdu = {};
      dptlib.populateAPDU(value, apdu, dpt);
      sent.push({ address, value, dpt, byte: apdu.data[0] });
    } },
  };
  knxHandler.write = KnxHandler.prototype.write.bind(knxHandler);
  // Evaluate the actual application wiring without starting MQTT/KNX networking.
  const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  const writeExpression = index.match(/writeKnx: ([^\n]+),\n  publishMqtt:/)?.[1];
  assert.ok(writeExpression, 'staircase KNX writer must be wired in index.js');
  const writeKnx = vm.runInNewContext(writeExpression, { knxHandler });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knx-dimmer-'));
  const logic = new StaircaseLogic({
    file: path.join(dir, 'logic.json'), writeKnx,
    publishMqtt: () => true,
    schedule: fn => { scheduled.push(fn); return fn; }, cancel: () => {},
  });
  logic.bindRouting({
    groupAddresses,
    routes: [{ id: 'r', from: { type: 'mqtt' }, to: { type: 'device' } }],
    endpoints: [],
    resolve: ref => ref.type === 'mqtt' ? { topic: 'trigger', type: 'boolean' } : { address: '1/0/8', type: 'boolean' },
  });
  logic.blocks.push(logic.validate({
    id: 'test', routeId: 'r', name: 'Dimmer', enabled: true, durationSeconds: 10,
    input: { type: 'mqtt', value: 'trigger' }, output: { type: 'knx', value: '1/0/8' },
    dimmer: { enabled: true, address: '2/2/11', percent },
  }));
  return { sent, logic, expire: () => scheduled.at(-1)(), cleanup: () => { logic.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('staircase dimmer sends 10% as DPT5.001, not OFF or a twice-scaled level', () => {
  const h = harness(10);
  try {
    h.logic.onRoute('r', 'ON');
    assert.deepEqual(h.sent.map(s => [s.address, s.dpt, s.byte]), [['2/2/11', 'DPT5.001', 26]]);
  } finally { h.cleanup(); }
});

test('staircase dimmer sends 80% and still switches OFF on expiry', () => {
  const h = harness(80);
  try {
    h.logic.onRoute('r', 'ON');
    assert.deepEqual(h.sent.map(s => s.byte), [204]);
    h.expire();
    assert.deepEqual(h.sent.map(s => [s.address, s.byte]), [['2/2/11', 204], ['1/0/8', 0]]);
  } finally { h.cleanup(); }
});
