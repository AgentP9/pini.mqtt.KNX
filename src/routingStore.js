'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Group addresses define KNX objects; routing graph defines all data flows.
class RoutingStore {
  constructor(deviceStore, groupAddresses, file) {
    this.deviceStore = deviceStore;
    this.groupAddresses = groupAddresses;
    this.file = file || process.env.ROUTING_PATH || path.join(path.dirname(deviceStore.file), 'routing.json');
    const raw = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    this.mqttDevices = raw.mqttDevices || [];
    this.endpoints = raw.endpoints || [];
    this.routes = raw.routes || [];
    this.knxMqttBaseTopic = raw.knxMqttBaseTopic || 'knx';
    this.validateAll(this.endpoints, this.routes, this.mqttDevices);
  }
  list() { return { endpoints: this.endpoints, mqttDevices: this.mqttDevices, routes: this.routes, knxMqttBaseTopic: this.knxMqttBaseTopic }; }
  resolve(ref, endpoints, mqttDevices = this.mqttDevices) {
    if (!ref || !['device', 'mqtt', 'mqttDevice'].includes(ref.type)) throw Error('Invalid endpoint type');
    if (ref.type === 'mqttDevice') {
      const device = mqttDevices.find(d => d.id === ref.id);
      const signal = device?.signals.find(x => x.key === ref.signal);
      if (!signal) throw Error('MQTT device signal missing');
      return { topic: signal.topic, type: signal.payloadType, direction: signal.direction, enabled: signal.enabled !== false };
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
    if (!object || !ga || (ga.dpt !== object.dpt && !(device.templateId === 'roller-shutter' && ref.signal === 'stop' && ['1.017', '1.009'].includes(ga.dpt)))) {
      throw Error('Device signal not configured: device=' + (device.name || device.id) + ', signal=' + ref.signal + ', GA=' + (address || 'missing') + ', actualDPT=' + (ga?.dpt || 'missing') + ', expectedDPT=' + (object?.dpt || 'missing'));
    }
    return { address, ga, type: ga.dpt.startsWith('1.') ? 'boolean' : ['10.001','11.001','19.001'].includes(ga.dpt) ? 'text' : 'number' };
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
    const mqttTopics = new Set(topics);
    for (const device of mqttDevices) {
      if (!device || typeof device.id !== 'string' || deviceIds.has(device.id) || typeof device.name !== 'string' ||
          !device.name.trim() || device.name.length > 120 || !['generic', 'sonos', 'shelly-plug-s', 'custom'].includes(device.templateId) ||
          !Array.isArray(device.signals) || !device.signals.length || device.signals.length > 30) throw Error('Invalid MQTT device');
      deviceIds.add(device.id);
      const keys = new Set();
      for (const signal of device.signals) {
        if (!signal || typeof signal.key !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(signal.key) || keys.has(signal.key) ||
            typeof signal.label !== 'string' || !signal.label.trim() || signal.label.length > 120 ||
            typeof signal.topic !== 'string' || !signal.topic || signal.topic.length > 240 || /[+#\s\u0000-\u001f]/.test(signal.topic) ||
            (signal.topic.startsWith('knx/') && !device.knxDeviceId) || mqttTopics.has(signal.topic) || !['boolean','number','text'].includes(signal.payloadType) ||
            !['input','output','both'].includes(signal.direction) || (signal.enabled !== undefined && typeof signal.enabled !== 'boolean')) throw Error('Invalid MQTT device signal');
        keys.add(signal.key);
        mqttTopics.add(signal.topic);
      }
    }
    const routeIds = new Set(), routePairs = new Set();
    for (const r of routes) {
      if (!r || typeof r.id !== 'string' || routeIds.has(r.id) || typeof r.enabled !== 'boolean') throw Error('Invalid route');
      routeIds.add(r.id);
      if (r.enabled && [r.from,r.to].some(ref => ref.type === 'mqttDevice' && mqttDevices.find(d => d.id === ref.id)?.signals.find(signal => signal.key === ref.signal)?.enabled === false)) throw Error('Enabled route references a disabled MQTT channel');
      if (r.bidirectional !== undefined && typeof r.bidirectional !== 'boolean') throw Error('Invalid bidirectional flag');
      if (r.bidirectional && r.from.type === 'device' && r.to.type === 'device') throw Error('Bidirectional routing requires KNX and MQTT');
      const src = this.resolve(r.from, endpoints, mqttDevices), dst = this.resolve(r.to, endpoints, mqttDevices);
      if (r.from.type !== 'device' && r.to.type !== 'device') throw Error('One side must be a KNX device');
      if (r.from.type === 'device' && r.to.type === 'device' && src.address === dst.address) throw Error('KNX source and target must use different group addresses');
      if (r.from.type === 'device' && r.to.type === 'device' && routes.some(other => other !== r && other.from?.type === 'device' && other.to?.type === 'device' && this.resolve(other.from, endpoints, mqttDevices).address === dst.address && this.resolve(other.to, endpoints, mqttDevices).address === src.address)) throw Error('Direct KNX feedback loop is not allowed');
      if (src.type !== dst.type && !r.transform) throw Error('Signal types differ; a conversion is required');
      if (r.bidirectional && r.transform && r.transform.kind !== 'map') throw Error('Bidirectional routing requires reversible value map');
      if (r.transform) {
        if (r.transform.kind === 'map') {
          if (!r.transform.values || typeof r.transform.values !== 'object' || Array.isArray(r.transform.values) ||
            Object.keys(r.transform.values).length > 30 || !Object.values(r.transform.values).every(v => ['string','number','boolean'].includes(typeof v)) || (Object.hasOwn(r.transform,'defaultValue') && !['string','number','boolean'].includes(typeof r.transform.defaultValue))) throw Error('Invalid value map');
        } else if (r.transform.kind === 'json') {
          if (typeof r.transform.path !== 'string' || !/^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*){0,9}$/.test(r.transform.path)) throw Error('Invalid JSON field path');
          if (r.transform.values !== undefined && (!r.transform.values || typeof r.transform.values !== 'object' || Array.isArray(r.transform.values) || Object.keys(r.transform.values).length > 30 || !Object.values(r.transform.values).every(v => ['string','number','boolean'].includes(typeof v)))) throw Error('Invalid JSON value map');
          if (Object.hasOwn(r.transform,'defaultValue') && !['string','number','boolean'].includes(typeof r.transform.defaultValue)) throw Error('Invalid JSON default value');
        } else if (r.transform.kind === 'constant') {
          if (!['string','number','boolean'].includes(typeof r.transform.value)) throw Error('Invalid constant');
        } else throw Error('Unsupported transformation');
      }
      const pair = JSON.stringify([r.from, r.to]);
      if (routePairs.has(pair)) throw Error('Duplicate connection between the same source and target');
      routePairs.add(pair);
    }
  }
  save(next) {    }
  }
  save(next) {
    const mqttDevices = next.mqttDevices === undefined ? this.mqttDevices : next.mqttDevices;
    this.validateAll(next.endpoints, next.routes, mqttDevices);
    const knxMqttBaseTopic = next.knxMqttBaseTopic === undefined ? this.knxMqttBaseTopic : next.knxMqttBaseTopic;
    if (typeof knxMqttBaseTopic !== 'string' || !knxMqttBaseTopic || knxMqttBaseTopic.length > 180 || /[+#\\s]/.test(knxMqttBaseTopic) || knxMqttBaseTopic.startsWith('/') || knxMqttBaseTopic.endsWith('/')) throw Error('Invalid KNX MQTT base topic');
    const data = JSON.stringify({ version: 3, endpoints: next.endpoints, mqttDevices, routes: next.routes, knxMqttBaseTopic }, null, 2) + '\n';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(tmp, data, { mode: 0o600 }); fs.renameSync(tmp, this.file); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    this.mqttDevices = mqttDevices;
    this.endpoints = next.endpoints;
    this.routes = next.routes;
    this.knxMqttBaseTopic = knxMqttBaseTopic;
    return this.list();
  }
}
module.exports = RoutingStore;
