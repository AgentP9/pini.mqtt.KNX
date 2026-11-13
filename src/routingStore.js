'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A separate sidecar: legacy GA routes and devices remain untouched.
class RoutingStore {
  constructor(deviceStore, groupAddresses, file) {
    this.deviceStore = deviceStore;
    this.groupAddresses = groupAddresses;
    this.file = file || process.env.ROUTING_PATH || path.join(path.dirname(deviceStore.file), 'routing.json');
    const raw = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    this.endpoints = raw.endpoints || [];
    this.routes = raw.routes || [];
    this.validateAll(this.endpoints, this.routes);
  }
  list() { return { endpoints: this.endpoints, routes: this.routes }; }
  legacyKey(address, topic, direction) { return JSON.stringify([address, topic, direction]); }
  migrated(address, topic, direction) {
    const key = this.legacyKey(address, topic, direction);
    return this.routes.some(r => r.enabled && r.legacyKey === key);
  }
  migrationPreview() {
    const candidates = [], skipped = [];
    const planned = new Set(this.routes.map(r => r.legacyKey).filter(Boolean));
    const used = new Set(this.endpoints.map(e => e.topic));
    const dests = new Set(this.routes.map(r => {
      try { const d = this.resolve(r.to, this.endpoints); return r.to.type === 'mqtt' ? 'topic:' + d.topic : 'ga:' + d.address; }
      catch (_) { return ''; }
    }));
    for (const ga of this.groupAddresses) {
      for (const legacy of ga.routes || []) {
        const topic = legacy.mqttTopic;
        if (!topic) continue;
        const directions = ['both', 'knx2mqtt'].includes(ga.direction || 'both') ? ['knx2mqtt'] : [];
        if (['both', 'mqtt2knx'].includes(ga.direction || 'both')) directions.push('mqtt2knx');
        for (const direction of directions) {
          const key = this.legacyKey(ga.address, topic, direction);
          if (planned.has(key)) continue;
          const info = { address: ga.address, topic, direction, key };
          let reason = '';
          if (legacy.valueMap && Object.keys(legacy.valueMap).length) reason = 'Value mapping not yet supported';
          else if (Number(legacy.repeatInterval) > 0) reason = 'Repeat interval not yet supported';
          else if (topic.startsWith('knx/')) reason = 'Reserved topic';
          const matches = [];
          for (const device of this.deviceStore.devices) {
            const tpl = this.deviceStore.templates().find(t => t.id === device.templateId);
            for (const obj of tpl?.objects || []) {
              if (device.addresses?.[obj.key] !== ga.address) continue;
              if (direction === 'mqtt2knx' && !['both','mqtt2knx'].includes(obj.direction || 'both')) continue;
              if (direction === 'knx2mqtt' && !['both','knx2mqtt'].includes(obj.direction || 'both')) continue;
              matches.push({ device, obj });
            }
          }
          if (!reason && matches.length !== 1) reason = matches.length ? 'Ambiguous device mapping' : 'No matching device signal';
          if (!reason && used.has(topic) && !this.endpoints.some(e => e.topic === topic)) reason = 'Topic collision';
          const type = ga.dpt?.startsWith('1.') ? 'boolean' : 'number';
          if (!reason && (!ga.dpt || (ga.dpt.startsWith('1.') === false && ga.dpt.startsWith('9.') === false))) reason = 'Unsupported DPT';
          if (!reason && direction === 'knx2mqtt' && dests.has('topic:' + topic)) reason = 'MQTT destination already used';
          if (!reason && direction === 'mqtt2knx' && dests.has('ga:' + ga.address)) reason = 'KNX destination already used';
          if (reason) skipped.push({ ...info, reason });
          else {
            const { device, obj } = matches[0];
            candidates.push({ ...info, deviceId: device.id, deviceName: device.name, signal: obj.key, type });
            if (direction === 'knx2mqtt') dests.add('topic:' + topic);
            else dests.add('ga:' + ga.address);
            used.add(topic);
          }
        }
      }
    }
    return { candidates, skipped };
  }
  migrate(keys) {
    if (!Array.isArray(keys) || !keys.every(k => typeof k === 'string')) throw Error('Invalid migration selection');
    const preview = this.migrationPreview();
    const requested = new Set(keys);
    if (requested.size !== keys.length || preview.candidates.filter(c => requested.has(c.key)).length !== keys.length) throw Error('Migration preview is outdated; refresh first');
    const endpoints = this.endpoints.map(e => ({ ...e }));
    const routes = this.routes.map(r => ({ ...r }));
    for (const c of preview.candidates.filter(c => requested.has(c.key))) {
      let ep = endpoints.find(e => e.topic === c.topic);
      if (!ep) {
        ep = { id: crypto.randomUUID(), name: c.deviceName + ' · ' + c.signal, topic: c.topic, payloadType: c.type };
        endpoints.push(ep);
      }
      if (ep.payloadType !== c.type) throw Error('Existing MQTT endpoint has incompatible type');
      const deviceRef = { type: 'device', id: c.deviceId, signal: c.signal };
      const mqttRef = { type: 'mqtt', id: ep.id };
      routes.push({ id: crypto.randomUUID(), from: c.direction === 'knx2mqtt' ? deviceRef : mqttRef,
        to: c.direction === 'knx2mqtt' ? mqttRef : deviceRef, enabled: true, legacyKey: c.key });
    }
    return this.save({ endpoints, routes });
  }
  resolve(ref, endpoints) {
    if (!ref || !['device', 'mqtt'].includes(ref.type)) throw Error('Invalid endpoint type');
    if (ref.type === 'mqtt') {
      const endpoint = endpoints.find(e => e.id === ref.id);
      if (!endpoint) throw Error('MQTT endpoint missing');
      return { topic: endpoint.topic, type: endpoint.payloadType };
    }
    const device = this.deviceStore.devices.find(d => d.id === ref.id);
    if (!device) throw Error('Device missing');
    const template = this.deviceStore.templates().find(t => t.id === device.templateId);
    const object = template && template.objects.find(o => o.key === ref.signal);
    const address = device.addresses[ref.signal];
    const ga = this.groupAddresses.find(g => g.address === address);
    if (!object || !ga || ga.dpt !== object.dpt) throw Error('Device signal not configured');
    return { address, ga, type: ga.dpt.startsWith('1.') ? 'boolean' : 'number' };
  }
  validateAll(endpoints, routes) {
    if (!Array.isArray(endpoints) || !Array.isArray(routes) || endpoints.length > 300 || routes.length > 500) throw Error('Invalid routing configuration');
    const ids = new Set(), topics = new Set();
    for (const e of endpoints) {
      if (!e || typeof e.id !== 'string' || ids.has(e.id) || typeof e.name !== 'string' || !e.name.trim() || e.name.length > 120 ||
        typeof e.topic !== 'string' || !e.topic || e.topic.length > 240 || /[+#\u0000-\u001f]/.test(e.topic) ||
        !['boolean', 'number', 'text'].includes(e.payloadType) || topics.has(e.topic)) throw Error('Invalid or duplicate MQTT endpoint');
      ids.add(e.id); topics.add(e.topic);
    }
    const routeIds = new Set(), destinations = new Set();
    for (const r of routes) {
      if (!r || typeof r.id !== 'string' || routeIds.has(r.id) || typeof r.enabled !== 'boolean') throw Error('Invalid route');
      routeIds.add(r.id);
      const src = this.resolve(r.from, endpoints), dst = this.resolve(r.to, endpoints);
      if (r.from.type === r.to.type) throw Error('Connect a device signal to an MQTT endpoint');
      if (src.type !== dst.type) throw Error('Signal types differ; a conversion is required');
      if (r.from.type === 'device' && !['both','knx2mqtt'].includes(src.ga.direction || 'both')) throw Error('Device signal is not readable');
      if (r.to.type === 'device' && !['both','mqtt2knx'].includes(dst.ga.direction || 'both')) throw Error('Device signal is not writable');
      if (r.to.type === 'mqtt' && dst.topic.startsWith('knx/')) throw Error('Reserved KNX topic namespace');
      if (r.from.type === 'mqtt' && src.topic.startsWith('knx/')) throw Error('Reserved KNX topic namespace');
      const key = r.to.type === 'mqtt' ? 'topic:' + dst.topic : 'ga:' + dst.address;
      if (destinations.has(key)) throw Error('Multiple routes write to the same destination');
      destinations.add(key);
      if (r.from.type === 'mqtt') {
        if (this.groupAddresses.some(g => (g.routes || []).some(legacy => legacy.mqttTopic === src.topic)) && !r.legacyKey) throw Error('MQTT topic is already handled by a legacy route');
      } else {
        if (this.groupAddresses.some(g => (g.routes || []).some(legacy => legacy.mqttTopic === dst.topic)) && !r.legacyKey) throw Error('MQTT topic already used by a legacy route');
      }
    }
  }
  save(next) {
    this.validateAll(next.endpoints, next.routes);
    const data = JSON.stringify({ version: 1, endpoints: next.endpoints, routes: next.routes }, null, 2) + '\n';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(tmp, data, { mode: 0o600 }); fs.renameSync(tmp, this.file); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    this.endpoints = next.endpoints;
    this.routes = next.routes;
    return this.list();
  }
}
module.exports = RoutingStore;
