'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_DURATION = 86400;
const isAddress = s => typeof s === 'string' && /^(?:[0-9]|[12][0-9]|3[01])\/(?:[0-7])\/(?:[0-9]{1,3})$/.test(s) && Number(s.split('/')[2]) <= 255;
const isTopic = s => typeof s === 'string' && s.length > 0 && s.length <= 256 && !/[+#\u0000]/.test(s) && !/\s/.test(s);

class StaircaseLogic {
  constructor({ file, publishMqtt, writeKnx, onChange = () => {}, now = () => Date.now(), schedule = setTimeout, cancel = clearTimeout }) {
    this.file = file;
    this.routingStore = null;
    this.publishMqtt = publishMqtt;
    this.writeKnx = writeKnx;
    this.onChange = onChange;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.timers = new Map();
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { blocks: [] };
    if (!Array.isArray(data.blocks)) throw Error('Invalid staircase configuration');
    this.blocks = data.blocks.map(b => this.validate(b));
  }
  validate(b) {
    if (!b || typeof b !== 'object') throw Error('Invalid logic block');
    const name = String(b.name || '').trim();
    if (!name || name.length > 120) throw Error('Name required (max 120 chars)');
    if (!Number.isInteger(b.durationSeconds) || b.durationSeconds < 1 || b.durationSeconds > MAX_DURATION) throw Error('Duration must be 1–86400 seconds');
    if (b.routeId && (typeof b.routeId !== 'string' || b.routeId.length > 120)) throw Error('Invalid route ID');
    for (const endpoint of [b.input, b.output]) {
      if (!endpoint || !['knx', 'mqtt'].includes(endpoint.type)) throw Error('Endpoint type must be knx or mqtt');
      if (endpoint.type === 'knx' ? !isAddress(endpoint.value) : !isTopic(endpoint.value)) throw Error('Invalid endpoint address/topic');
    }
    if (b.input.type === b.output.type && b.input.value === b.output.value) throw Error('Input and output must differ (feedback loop)');
    return { id: b.id || crypto.randomUUID(), routeId: b.routeId || null, name, enabled: b.enabled !== false, durationSeconds: b.durationSeconds, input: { type: b.input.type, value: b.input.value }, output: { type: b.output.type, value: b.output.value } };
  }
  list() {
    return this.blocks.map(b => ({ ...b, active: this.timers.has(b.id), expiresAt: this.timers.get(b.id)?.expiresAt || null }));
  }
  persist(blocks) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, blocks }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  bindRouting(store) { this.routingStore = store; }
  routeEndpoints(routeId) {
    const route = this.routingStore?.routes.find(r => r.id === routeId);
    if (!route) throw Error('Connection does not exist; create a connection first');
    if (route.bidirectional) throw Error('Logic requires a unidirectional connection');
    const from = this.routingStore.resolve(route.from, this.routingStore.endpoints);
    const to = this.routingStore.resolve(route.to, this.routingStore.endpoints);
    if (from.type !== 'boolean' || to.type !== 'boolean') throw Error('Staircase logic requires boolean signals');
    const endpoint = x => x.address ? { type: 'knx', value: x.address } : { type: 'mqtt', value: x.topic };
    return { input: endpoint(from), output: endpoint(to) };
  }
  onRoute(routeId, payload) {
    const block = this.blocks.find(b => b.routeId === routeId && b.enabled);
    if (!block) return false;
    // Consume the original route, never forward the unmodified command.
    if (!['ON','OFF','TRUE','FALSE','1','0','OK'].includes(String(payload).trim().toUpperCase())) return true;
    this.trigger(block.input.type, block.input.value, payload, routeId);
    return true;
  }
  save(payload, id) {
    if (!payload.routeId) throw Error('Select an existing connection first');
    const endpoints = this.routeEndpoints(payload.routeId);
    payload = { ...payload, ...endpoints };
    if (this.blocks.some(b => b.id !== id && b.routeId === payload.routeId)) throw Error('Connection already has a logic block');
    if (id && !this.blocks.some(b => b.id === id)) return null;
    const candidate = this.validate({ ...payload, id: id || crypto.randomUUID() });
    if (this.blocks.some(b => b.id !== candidate.id && b.input.type === candidate.input.type && b.input.value === candidate.input.value && b.output.type === candidate.output.type && b.output.value === candidate.output.value)) throw Error('Duplicate input/output pair');
    const next = id ? this.blocks.map(b => b.id === id ? candidate : b) : [...this.blocks, candidate];
    if (next.length > 100) throw Error('Maximum 100 logic blocks');
    this.persist(next);
    if (id) this.stop(id);
    this.blocks = next;
    this.onChange(this.list());
    return candidate;
  }
  remove(id) {
    if (!this.blocks.some(b => b.id === id)) return false;
    const next = this.blocks.filter(b => b.id !== id);
    this.persist(next);
    this.stop(id);
    this.blocks = next;
    this.onChange(this.list());
    return true;
  }
  stop(id) {
    const timer = this.timers.get(id);
    if (timer) this.cancel(timer.handle);
    this.timers.delete(id);
  }
  send(endpoint, value) {
    if (endpoint.type === 'knx') return this.writeKnx(endpoint.value, value);
    return this.publishMqtt(endpoint.value, value);
  }
  trigger(type, value, payload, routeId = null) {
    // KNX DPT1.017: both telegram values are triggers; MQTT accepts explicit ON/OFF equivalents.
    if (type === 'mqtt' && !['ON', 'OFF', 'TRUE', 'FALSE', '1', '0'].includes(String(payload).trim().toUpperCase())) return;
    for (const block of this.blocks) {
      if (!block.enabled || block.input.type !== type || block.input.value !== value || (routeId ? block.routeId !== routeId : Boolean(block.routeId))) continue;
      // Only arm when the ON command can actually be delivered.
      if (this.send(block.output, 'ON') === false) continue;
      this.stop(block.id);
      const expiresAt = this.now() + block.durationSeconds * 1000;
      const handle = this.schedule(() => {
        if (this.timers.get(block.id)?.expiresAt !== expiresAt) return;
        this.timers.delete(block.id);
        this.send(block.output, 'OFF');
        this.onChange(this.list());
      }, block.durationSeconds * 1000);
      this.timers.set(block.id, { handle, expiresAt });
      this.onChange(this.list());
    }
  }
  mqttTopics() { return [...new Set(this.blocks.filter(b => b.enabled && b.input.type === 'mqtt').map(b => b.input.value))]; }
  close() { for (const id of this.timers.keys()) this.stop(id); }
}
module.exports = StaircaseLogic;
