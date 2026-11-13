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
    this.mqttDevices = raw.mqttDevices || [];
    this.endpoints = raw.endpoints || [];
    this.routes = raw.routes || [];
    this.validateAll(this.endpoints, this.routes, this.mqttDevices);
  }
  list() { return { endpoints: this.endpoints, mqttDevices: this.mqttDevices, routes: this.routes }; }
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
          if (Number(legacy.repeatInterval) > 0) reason = 'Repeat interval not yet supported';
          else if (direction === 'mqtt2knx' && legacy.valueMap && Object.keys(legacy.valueMap).length) reason = 'Reverse value mapping requires manual review';
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
          if (!reason && used.has(topic) && !this.endpoints.some(e => e.topic === topic) && !candidates.some(c => c.topic === topic)) reason = 'Topic collision';
          const type = ga.dpt?.startsWith('1.') ? 'boolean' : 'number';
          if (!reason && (!ga.dpt || (ga.dpt.startsWith('1.') === false && ga.dpt.startsWith('9.') === false))) reason = 'Unsupported DPT';
          if (!reason && direction === 'knx2mqtt' && dests.has('topic:' + topic)) reason = 'MQTT destination already used';
          if (!reason && direction === 'mqtt2knx' && dests.has('ga:' + ga.address)) reason = 'KNX destination already used';
          if (reason) skipped.push({ ...info, reason });
          else {
            const { device, obj } = matches[0];
            const outputType = direction === 'knx2mqtt' && legacy.valueMap && Object.keys(legacy.valueMap).length ? 'text' : type;
            candidates.push({ ...info, deviceId: device.id, deviceName: device.name, signal: obj.key, type, outputType, valueMap: legacy.valueMap || null,
              suggestedDevice: /^sonos\/devices\/([^/]+)\//.test(topic) ? { templateId: 'sonos', name: topic.split('/')[2], baseTopic: topic.split('/').slice(0, 3).join('/') } : null });
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
    const mqttDevices = this.mqttDevices.map(d => ({ ...d, signals: d.signals.map(x => ({ ...x })) }));
    const routes = this.routes.map(r => ({ ...r }));
    for (const c of preview.candidates.filter(c => requested.has(c.key))) {
      let ep = endpoints.find(e => e.topic === c.topic);
      if (!ep) {
        ep = { id: crypto.randomUUID(), name: c.deviceName + ' · ' + c.signal, topic: c.topic, payloadType: c.outputType };
        endpoints.push(ep);
      }
      if (ep.payloadType !== c.outputType) throw Error('Existing MQTT endpoint has incompatible type');
      const deviceRef = { type: 'device', id: c.deviceId, signal: c.signal };
      const mqttRef = { type: 'mqtt', id: ep.id };
      const transform = c.direction === 'knx2mqtt' && c.valueMap && Object.keys(c.valueMap).length ?
        { kind: 'map', values: c.valueMap } : undefined;
      routes.push({ id: crypto.randomUUID(), from: c.direction === 'knx2mqtt' ? deviceRef : mqttRef,
        to: c.direction === 'knx2mqtt' ? mqttRef : deviceRef, enabled: true, legacyKey: c.key, ...(transform ? { transform } : {}) });
    }
    return this.save({ endpoints, mqttDevices, routes });
  }
  resolve(ref, endpoints, mqttDevices = this.mqttDevices) {
    if (!ref || !['device', 'mqtt', 'mqttDevice'].includes(ref.type)) throw Error('Invalid endpoint type');
    if (ref.type === 'mqttDevice') {
      const device = mqttDevices.find(d => d.id === ref.id);
      const signal = device?.signals.find(x => x.key === ref.signal);
      if (!signal) throw Error('MQTT device signal missing');
      return { topic: signal.topic, type: signal.payloadType, direction: signal.direction };
    }
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
  validateAll(endpoints, routes, mqttDevices = this.mqttDevices) {
    if (!Array.isArray(endpoints) || !Array.isArray(routes) || endpoints.length > 300 || routes.length > 500) throw Error('Invalid routing configuration');
    const ids = new Set(), topics = new Set();
    for (const e of endpoints) {
      if (!e || typeof e.id !== 'string' || ids.has(e.id) || typeof e.name !== 'string' || !e.name.trim() || e.name.length > 120 ||
        typeof e.topic !== 'string' || !e.topic || e.topic.length > 240 || /[+#\u0000-\u001f]/.test(e.topic) ||
        !['boolean', 'number', 'text'].includes(e.payloadType) || topics.has(e.topic)) throw Error('Invalid or duplicate MQTT endpoint');
      ids.add(e.id); topics.add(e.topic);
    }
    if (!Array.isArray(mqttDevices) || mqttDevices.length > 100) throw Error('Invalid MQTT devices');
    const deviceIds = new Set();
    for (const device of mqttDevices) {
      if (!device || typeof device.id !== 'string' || deviceIds.has(device.id) || typeof device.name !== 'string' ||
          !device.name.trim() || device.name.length > 120 || !['generic', 'sonos'].includes(device.templateId) ||
          !Array.isArray(device.signals) || !device.signals.length || device.signals.length > 30) throw Error('Invalid MQTT device');
      deviceIds.add(device.id);
      const keys = new Set();
      for (const signal of device.signals) {
        if (!signal || typeof signal.key !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(signal.key) || keys.has(signal.key) ||
            typeof signal.label !== 'string' || !signal.label.trim() || signal.label.length > 120 ||
            typeof signal.topic !== 'string' || !signal.topic || signal.topic.length > 240 || /[+#\s\u0000-\u001f]/.test(signal.topic) ||
            signal.topic.startsWith('knx/') || !['boolean','number','text'].includes(signal.payloadType) ||
            !['input','output','both'].includes(signal.direction)) throw Error('Invalid MQTT device signal');
        keys.add(signal.key);
      }
    }
    const routeIds = new Set(), destinations = new Set();
    for (const r of routes) {
      if (!r || typeof r.id !== 'string' || routeIds.has(r.id) || typeof r.enabled !== 'boolean') throw Error('Invalid route');
      routeIds.add(r.id);
      if (r.legacyKey) {
        const source = r.from.type === 'device' ? r.from : r.to;
        const mqttRef = r.from.type === 'mqtt' ? r.from : r.to;
        const device = this.deviceStore.devices.find(d => d.id === source.id);
        const endpoint = endpoints.find(e => e.id === mqttRef.id);
        const address = device?.addresses?.[source.signal];
        const direction = r.from.type === 'device' ? 'knx2mqtt' : 'mqtt2knx';
        if (!address || !endpoint || r.legacyKey !== this.legacyKey(address, endpoint.topic, direction) ||
          !this.groupAddresses.some(g => g.address === address && (g.routes || []).some(legacy => legacy.mqttTopic === endpoint.topic))) {
          throw Error('Invalid legacy migration reference');
        }
      }
      const src = this.resolve(r.from, endpoints, mqttDevices), dst = this.resolve(r.to, endpoints, mqttDevices);
      if (r.from.type !== 'device' && r.to.type !== 'device') throw Error('One side must be a KNX device');
      if (r.from.type === 'device' && r.to.type === 'device') throw Error('Connect a KNX device to an MQTT endpoint');
      if (r.from.type === 'device' && !['both','knx2mqtt'].includes(src.ga.direction || 'both')) throw Error('Device signal is not readable');
      if (r.to.type === 'device' && !['both','mqtt2knx'].includes(dst.ga.direction || 'both')) throw Error('Device signal is not writable');
      if (r.from.type === 'mqttDevice' && !['output','both'].includes(src.direction)) throw Error('MQTT signal is not readable');
      if (r.to.type === 'mqttDevice' && !['input','both'].includes(dst.direction)) throw Error('MQTT signal is not writable');
      if (src.type !== dst.type && !r.transform) throw Error('Signal types differ; a conversion is required');
      if (r.transform) {
        if (r.from.type !== 'device') throw Error('Transformations currently require a KNX source');
        if (r.transform.kind === 'map') {
          if (!r.transform.values || typeof r.transform.values !== 'object' || Array.isArray(r.transform.values) ||
            Object.keys(r.transform.values).length > 30 || !Object.values(r.transform.values).every(v => ['string','number','boolean'].includes(typeof v))) throw Error('Invalid value map');
        } else if (r.transform.kind === 'constant') {
          if (!['string','number','boolean'].includes(typeof r.transform.value)) throw Error('Invalid constant');
        } else throw Error('Unsupported transformation');
      }
      const key = r.to.type === 'device' ? 'ga:' + dst.address : 'topic:' + dst.topic;
      if (destinations.has(key)) throw Error('Multiple routes write to the same destination');
      destinations.add(key);
      if (r.from.type !== 'device') {
        if (this.groupAddresses.some(g => (g.routes || []).some(legacy => legacy.mqttTopic === src.topic)) && !r.legacyKey) throw Error('MQTT topic is already handled by a legacy route');
      } else {
        if (this.groupAddresses.some(g => (g.routes || []).some(legacy => legacy.mqttTopic === dst.topic)) && !r.legacyKey) throw Error('MQTT topic already used by a legacy route');
      }
    }
  }
  save(next) {
    const mqttDevices = next.mqttDevices === undefined ? this.mqttDevices : next.mqttDevices;
    this.validateAll(next.endpoints, next.routes, mqttDevices);
    const data = JSON.stringify({ version: 2, endpoints: next.endpoints, mqttDevices, routes: next.routes }, null, 2) + '\n';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(tmp, data, { mode: 0o600 }); fs.renameSync(tmp, this.file); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    this.mqttDevices = mqttDevices;
    this.endpoints = next.endpoints;
    this.routes = next.routes;
    return this.list();
  }
}
module.exports = RoutingStore;
