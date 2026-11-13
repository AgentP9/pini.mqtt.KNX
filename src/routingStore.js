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
        if (this.groupAddresses.some(g => (g.routes || []).some(legacy => legacy.mqttTopic === src.topic))) throw Error('MQTT topic is already handled by a legacy route');
      } else {
        if ((src.ga.routes || []).some(legacy => legacy.mqttTopic === dst.topic)) throw Error('Route already exists in legacy configuration');
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
