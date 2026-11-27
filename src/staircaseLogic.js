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
    this.permissions = new Map();
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
    const enableInput = b.enableInput || null;
    if (enableInput) {
      if (!['knx','mqtt'].includes(enableInput.type) || !(enableInput.type === 'knx' ? isAddress(enableInput.value) : isTopic(enableInput.value))) throw Error('Invalid enable input');
      if ([b.input,b.output].some(e => e.type === enableInput.type && e.value === enableInput.value)) throw Error('Enable input must differ from trigger and output');
      if (enableInput.type === 'knx' && this.routingStore && !this.routingStore.groupAddresses?.some(g => g.address === enableInput.value && ['1.001','1.002'].includes(g.dpt))) throw Error('Enable input requires DPT 1.001 or 1.002');
    }
    const dimmer = b.dimmer || { enabled: false };
    if (typeof dimmer.enabled !== 'boolean' && dimmer.enabled !== undefined) throw Error('Invalid dimmer enabled flag');
    if (dimmer.enabled) {
      if (!isAddress(dimmer.address)) throw Error('Dimmer KNX group address required');
      if (!Number.isInteger(dimmer.percent) || dimmer.percent < 1 || dimmer.percent > 100) throw Error('Dimmer level must be 1–100%');
      if (dimmer.address === b.input.value || dimmer.address === b.output.value) throw Error('Dimmer address must differ from trigger and switch');
      const ga = this.routingStore?.groupAddresses?.find(g => g.address === dimmer.address);
      if (this.routingStore && ga?.dpt !== '5.001') throw Error('Dimmer address must have DPT 5.001');
    }
    if (b.input.type === b.output.type && b.input.value === b.output.value) throw Error('Input and output must differ (feedback loop)');
    return { id: b.id || crypto.randomUUID(), routeId: b.routeId || null, name, enableInput, enabled: b.enabled !== false, durationSeconds: b.durationSeconds, dimmer: dimmer.enabled ? { enabled: true, address: dimmer.address, percent: dimmer.percent } : { enabled: false }, input: { type: b.input.type, value: b.input.value }, output: { type: b.output.type, value: b.output.value } };
  }
  list() {
    return this.blocks.map(b => ({ ...b, released: !b.enableInput || this.permissions.get(b.id) === true, active: this.timers.has(b.id), expiresAt: this.timers.get(b.id)?.expiresAt || null }));
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
    if (!['ON','OFF','TRUE','FALSE','1','0'].includes(String(payload).trim().toUpperCase())) return true;
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
    if (id) {
      this.stop(id);
      if (JSON.stringify(this.blocks.find(b => b.id === id)?.enableInput) !== JSON.stringify(candidate.enableInput)) this.permissions.delete(id);
    }
    this.blocks = next;
    this.onChange(this.list());
    return candidate;
  }
  remove(id) {
    if (!this.blocks.some(b => b.id === id)) return false;
    const next = this.blocks.filter(b => b.id !== id);
    this.persist(next);
    this.stop(id);
    this.permissions.delete(id);
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
    const command = String(payload).trim().toUpperCase();
    if (!['ON','OFF','TRUE','FALSE','1','0'].includes(command)) return;
    const isOn = ['ON','TRUE','1'].includes(command);
    for (const block of this.blocks) {
      if (!routeId && block.enabled && block.enableInput?.type === type && block.enableInput.value === value) {
        const released = block.enableInput.inverted === true ? !isOn : isOn;
        this.permissions.set(block.id, released);
        if (!released) { this.stop(block.id); this.send(block.output, 'OFF'); }
        this.onChange(this.list());
      }
      if (!block.enabled || (block.enableInput && this.permissions.get(block.id) !== true) || block.input.type !== type || block.input.value !== value || (routeId ? block.routeId !== routeId : Boolean(block.routeId))) continue;
      this.stop(block.id);
      if (isOn) {
        if (block.dimmer?.enabled) this.writeKnx(block.dimmer.address, String(block.dimmer.percent));
        else this.send(block.output, 'ON');
        this.onChange(this.list());
        continue;
      }
      const expiresAt = this.now() + block.durationSeconds * 1000;
      const token = {};
      const handle = this.schedule(() => {
        if (this.timers.get(block.id)?.token !== token) return;
        this.timers.delete(block.id);
        this.send(block.output, 'OFF');
        this.onChange(this.list());
      }, block.durationSeconds * 1000);
      this.timers.set(block.id, { handle, expiresAt, token });
      this.onChange(this.list());
    }
  }
  mqttTopics() { return [...new Set(this.blocks.filter(b => b.enabled).flatMap(b => [b.input,b.enableInput].filter(e => e?.type === 'mqtt').map(e => e.value)))]; }
  close() { for (const id of this.timers.keys()) this.stop(id); }
}
module.exports = StaircaseLogic;
