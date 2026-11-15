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
      { key: 'status', label: 'Switch status', dpt: '1.011', direction: 'knx2mqtt' },
    ],
  },
  'dimmer': {
    id: 'dimmer', name: 'Dimmer',
    objects: [
      { key: 'command', label: 'Switch command', dpt: '1.001', direction: 'both' },
      { key: 'dimRelative', label: 'Relative dimming', dpt: '3.007', direction: 'both' },
      { key: 'status', label: 'Switch status', dpt: '1.011', direction: 'knx2mqtt' },
      { key: 'brightness', label: 'Brightness value', dpt: '5.001', direction: 'knx2mqtt' },
    ],
  },
  'roller-shutter': {
    id: 'roller-shutter', name: 'Rollladen',
    objects: [
      { key: 'upDown', label: 'Auf/Ab', dpt: '1.008', direction: 'both' },
      { key: 'stop', label: 'Stopp/Schritt', dpt: '1.017', direction: 'both' },
      { key: 'position', label: 'Position', dpt: '5.001', direction: 'knx2mqtt' },
    ],
  },
  'bigassfan': {
    id: 'bigassfan', name: 'BigAssFan',
    objects: [
      { key: 'fanCommand', label: 'Fan power', dpt: '1.001', direction: 'mqtt2knx' },
      { key: 'fanStatus', label: 'Fan power status', dpt: '1.011', direction: 'knx2mqtt' },
      { key: 'lightCommand', label: 'Light', dpt: '1.001', direction: 'mqtt2knx' },
      { key: 'lightStatus', label: 'Light status', dpt: '1.011', direction: 'knx2mqtt' },
    ],
  },
  'sonos': {
    id: 'sonos', name: 'Sonos',
    objects: [
      { key: 'command', label: 'Switch command', dpt: '1.001', direction: 'both' },
      { key: 'status', label: 'Switch status', dpt: '1.011', direction: 'knx2mqtt' },
      { key: 'volume', label: 'Volume', dpt: '3.007', direction: 'knx2mqtt', optional: true },
      { key: 'volumeStatus', label: 'Volume status', dpt: '5.001', direction: 'knx2mqtt', optional: true },
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
    this.roomsFile = process.env.ROOMS_PATH || path.join(path.dirname(this.file), 'rooms.json');
    this.rooms = fs.existsSync(this.roomsFile) ? JSON.parse(fs.readFileSync(this.roomsFile, 'utf8')) : [];
    if (!Array.isArray(this.rooms)) throw new Error('rooms.json must contain an array');
    this.devices = [];
    if (fs.existsSync(this.file)) {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(data)) throw new Error('devices.json must contain an array');
      this.devices = data;
    }
  }
  listRooms() { return this.rooms.map(r => ({ ...r, deviceCount: this.devices.filter(d => d.roomId === r.id).length })); }
  saveRoom(input, id) {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 120) throw new Error('Room name is required (max 120 chars)');
    if (this.rooms.some(r => r.name.toLowerCase() === name.toLowerCase() && r.id !== id)) throw new Error('Room already exists');
    const existing = id ? this.rooms.find(r => r.id === id) : null;
    if (id && !existing) return null;
    const room = { id: existing?.id || crypto.randomUUID(), name };
    const next = existing ? this.rooms.map(r => r.id === id ? room : r) : [...this.rooms, room];
    this.persistRooms(next);
    return room;
  }
  persistRooms(next) {
    fs.mkdirSync(path.dirname(this.roomsFile), { recursive: true });
    const tmp = this.roomsFile + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
      fs.renameSync(tmp, this.roomsFile);
    } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
    this.rooms = next;
  }
  removeRoom(id) {
    if (!this.rooms.some(r => r.id === id)) return false;
    if (this.devices.some(d => d.roomId === id)) throw new Error('Room still contains devices');
    this.persistRooms(this.rooms.filter(r => r.id !== id));
    return true;
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
      if (obj.direction === 'mqtt2knx' && direction === 'knx2mqtt') throw new Error('Direction mismatch for ' + addr);
      if (obj.direction === 'both' && direction !== 'both') throw new Error('Bidirectional object requires both directions: ' + addr);
      addresses[obj.key] = addr;
    }
    for (const d of this.devices) {
      if (d.id === exceptId) continue;
      for (const addr of Object.values(addresses)) if (Object.values(d.addresses).includes(addr)) throw new Error('Address already assigned to device ' + d.name + ': ' + addr);
    }
    const roomId = input.roomId || null;
    if (roomId !== null && (typeof roomId !== 'string' || !this.rooms.some(r => r.id === roomId))) throw new Error('Unknown room');
    return { name: input.name.trim(), templateId: tpl.id, addresses, roomId };
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
