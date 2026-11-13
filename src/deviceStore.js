'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Devices are metadata referencing existing KNX addresses, never replacements for them.
// The sidecar file keeps legacy groupaddresses.json byte-for-byte compatible.
const TEMPLATES = Object.freeze({
  'switch': {
    id: 'switch', name: 'Switch',
    objects: [
      { key: 'command', label: 'Switch command', dpt: '1.001', direction: 'both' },
      { key: 'status', label: 'Switch status', dpt: '1.001', direction: 'knx2mqtt' },
    ],
  },
  'room-heating': {
    id: 'room-heating', name: 'Room heating',
    objects: [
      { key: 'temperature', label: 'Current temperature', dpt: '9.001', direction: 'knx2mqtt' },
      { key: 'setpoint', label: 'Current setpoint', dpt: '9.001', direction: 'both' },
      { key: 'offset', label: 'Setpoint shift', dpt: '1.007', direction: 'both', optional: true },
    ],
  },
});
const GA_RE = /^(?:[0-9]|[1-2][0-9]|3[01])\/(?:[0-7])\/(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/;
class DeviceStore {
  constructor(groupAddresses, groupAddressesPath) {
    this.groupAddresses = groupAddresses;
    this.file = process.env.DEVICES_PATH || path.join(path.dirname(groupAddressesPath), 'devices.json');
    this.devices = [];
    if (fs.existsSync(this.file)) {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(data)) throw new Error('devices.json must contain an array');
      this.devices = data;
    }
  }
  list() { return this.devices.map(d => ({ ...d, missing: Object.values(d.addresses).filter(a => !this.groupAddresses.some(g => g.address === a)) })); }
  templates() { return Object.values(TEMPLATES); }
  validate(input, exceptId) {
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw new Error('Device name is required (max 120 chars)');
    const tpl = TEMPLATES[input.templateId];
    if (!tpl) throw new Error('Unknown device template');
    if (!input.addresses || typeof input.addresses !== 'object' || Array.isArray(input.addresses)) throw new Error('Address mapping is required');
    const addresses = {};
    for (const key of Object.keys(input.addresses)) if (!tpl.objects.some(o => o.key === key)) throw new Error('Unknown object: ' + key);
    for (const obj of tpl.objects) {
      const addr = String(input.addresses[obj.key] || '').trim();
      if (!addr && obj.optional) continue;
      if (!GA_RE.test(addr)) throw new Error('Invalid or missing group address for ' + obj.label);
      if (Object.values(addresses).includes(addr)) throw new Error('Duplicate address in device: ' + addr);
      const ga = this.groupAddresses.find(g => g.address === addr);
      if (!ga) throw new Error('Group address not configured: ' + addr);
      if (ga.dpt && ga.dpt !== obj.dpt) throw new Error('DPT mismatch for ' + addr + ': expected ' + obj.dpt);
      const direction = ga.direction || 'both';
      if (obj.direction === 'knx2mqtt' && direction === 'mqtt2knx') throw new Error('Direction mismatch for ' + addr);
      if (obj.direction === 'both' && direction !== 'both') throw new Error('Bidirectional object requires both directions: ' + addr);
      addresses[obj.key] = addr;
    }
    for (const d of this.devices) {
      if (d.id === exceptId) continue;
      for (const addr of Object.values(addresses)) if (Object.values(d.addresses).includes(addr)) throw new Error('Address already assigned to device ' + d.name + ': ' + addr);
    }
    return { name: input.name.trim(), templateId: tpl.id, addresses };
  }
  persist(next) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
      fs.renameSync(tmp, this.file);
    } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
    this.devices = next;
  }
  save(input, id) {
    const existing = id && this.devices.find(d => d.id === id);
    if (id && !existing) return null;
    const fields = this.validate(input, id);
    const device = { id: existing ? existing.id : crypto.randomUUID(), ...fields };
    this.persist(existing ? this.devices.map(d => d.id === id ? device : d) : [...this.devices, device]);
    return device;
  }
  remove(id) {
    if (!this.devices.some(d => d.id === id)) return false;
    this.persist(this.devices.filter(d => d.id !== id));
    return true;
  }
}
module.exports = DeviceStore;
