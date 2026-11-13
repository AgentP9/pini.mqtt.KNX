'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const DeviceStore = require('../src/deviceStore');
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knx-devices-'));
  const gaPath = path.join(dir, 'groupaddresses.json');
  const gas = [
    { address: '1/0/0', dpt: '9.001', direction: 'knx2mqtt' },
    { address: '1/0/1', dpt: '9.001', direction: 'both' },
    { address: '1/0/2', dpt: '1.007', direction: 'both' },
    { address: '1/1/0', dpt: '9.001', direction: 'knx2mqtt' },
    { address: '1/1/1', dpt: '9.001', direction: 'both' },
  ];
  fs.writeFileSync(gaPath, JSON.stringify(gas));
  return { dir, gaPath, gas, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
test('legacy GAs stay unchanged; device metadata persists across restart', () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.gaPath, 'utf8');
    const store = new DeviceStore(f.gas, f.gaPath);
    assert.deepEqual(store.list(), []);
    const d = store.save({ name: 'Office', templateId: 'room-heating', addresses: { temperature: '1/0/0', setpoint: '1/0/1', offset: '1/0/2' } });
    assert.ok(d.id);
    assert.equal(new DeviceStore(f.gas, f.gaPath).list()[0].name, 'Office');
    assert.equal(fs.readFileSync(f.gaPath, 'utf8'), before);
    assert.ok(store.remove(d.id));
    assert.equal(store.list().length, 0);
    assert.equal(f.gas.length, 5);
  } finally { f.cleanup(); }
});
test('reject missing GAs, DPT mismatch, and duplicate ownership', () => {
  const f = fixture();
  try {
    const store = new DeviceStore(f.gas, f.gaPath);
    const first = { name: 'Office', templateId: 'room-heating', addresses: { temperature: '1/0/0', setpoint: '1/0/1' } };
    assert.throws(() => store.save({ ...first, addresses: { temperature: '1/0/9', setpoint: '1/0/1' } }), /not configured/);
    assert.throws(() => store.save({ ...first, addresses: { temperature: '1/0/2', setpoint: '1/0/1' } }), /DPT mismatch/);
    store.save(first);
    assert.throws(() => store.save({ ...first, name: 'Duplicate' }), /already assigned/);
    const second = store.save({ name: 'Living', templateId: 'room-heating', addresses: { temperature: '1/1/0', setpoint: '1/1/1' } });
    assert.equal(store.list().length, 2);
    assert.equal(store.list().find(d => d.id === second.id).missing.length, 0);
    f.gas.pop();
    assert.deepEqual(store.list().find(d => d.id === second.id).missing, ['1/1/1']);
  } finally { f.cleanup(); }
});
test('invalid direction is rejected and updates preserve device ID', () => {
  const f = fixture();
  try {
    const store = new DeviceStore(f.gas, f.gaPath);
    f.gas[1].direction = 'knx2mqtt';
    assert.throws(() => store.save({ name: 'Office', templateId: 'room-heating', addresses: { temperature: '1/0/0', setpoint: '1/0/1' } }), /Bidirectional/);
    f.gas[1].direction = 'both';
    const d = store.save({ name: 'Office', templateId: 'room-heating', addresses: { temperature: '1/0/0', setpoint: '1/0/1' } });
    const updated = store.save({ ...d, name: 'New Office' }, d.id);
    assert.equal(updated.id, d.id);
    assert.equal(store.list()[0].name, 'New Office');
  } finally { f.cleanup(); }
});

test('switch template maps DPT 1.001 command and DPT 1.011 status without changing group addresses', () => {
  const f = fixture();
  try {
    f.gas.push({ address: '2/0/0', dpt: '1.001', direction: 'both' });
    f.gas.push({ address: '2/0/1', dpt: '1.011', direction: 'knx2mqtt' });
    const before = fs.readFileSync(f.gaPath, 'utf8');
    const store = new DeviceStore(f.gas, f.gaPath);
    assert.ok(store.templates().some(t => t.id === 'switch'));
    const d = store.save({ name: 'Ceiling light', templateId: 'switch', addresses: { command: '2/0/0', status: '2/0/1' } });
    assert.deepEqual(d.addresses, { command: '2/0/0', status: '2/0/1' });
    assert.equal(new DeviceStore(f.gas, f.gaPath).list()[0].templateId, 'switch');
    assert.equal(fs.readFileSync(f.gaPath, 'utf8'), before);
    assert.throws(() => store.save({ name: 'Wrong DPT', templateId: 'switch', addresses: { command: '1/0/1', status: '2/0/1' } }), /DPT mismatch/);
    f.gas.find(g => g.address === '2/0/0').direction = 'knx2mqtt';
    assert.throws(() => store.save({ name: 'Wrong direction', templateId: 'switch', addresses: { command: '2/0/0', status: '2/0/1' } }, d.id), /Bidirectional/);
  } finally { f.cleanup(); }
});
