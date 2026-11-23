'use strict';

const EventEmitter = require('events');
const config = require('./config');
const KnxHandler = require('./knxHandler');
const MqttHandler = require('./mqttHandler');
const WebServer = require('./webServer');
const StaircaseLogic = require('./staircaseLogic');
const path = require('path');

const eventEmitter = new EventEmitter();

// ── Web dashboard ──────────────────────────────────────────────────────────────
const webServer = new WebServer(config.webPort, eventEmitter, config.groupAddresses, config.groupAddressesPath); // eslint-disable-line no-unused-vars

// ── Connections ────────────────────────────────────────────────────────────────
const knxHandler = new KnxHandler(config.knx, config.groupAddresses);
const mqttHandler = new MqttHandler(config.mqtt);

// Staircase timers are owned by the backend, not the browser.
const staircaseLogic = new StaircaseLogic({
  file: process.env.STAIRCASE_LOGIC_PATH || path.join(path.dirname(config.groupAddressesPath), 'staircase-logic.json'),
  writeKnx: (address, value) => knxHandler.write(address, value === 'ON' ? '1' : value === 'OFF' ? '0' : value),
  publishMqtt: (topic, value) => {
    if (!mqttHandler.connected) return false;
    mqttHandler.publish(topic, value);
    return true;
  },
  onChange: blocks => eventEmitter.emit('staircase-changed', blocks),
});
webServer.staircaseLogic = staircaseLogic;
eventEmitter.on('staircase-changed', blocks => {
  webServer.io.emit('staircase', blocks);
  if (mqttHandler.connected) staircaseLogic.mqttTopics().forEach(topic => mqttHandler.subscribe(topic));
});
knxHandler.on('groupValueWrite', ({ address, value }) => staircaseLogic.trigger('knx', address, value));
mqttHandler.on('message', ({ topic, value }) => staircaseLogic.trigger('mqtt', topic, value));
mqttHandler.on('connected', () => staircaseLogic.mqttTopics().forEach(topic => mqttHandler.subscribe(topic)));

// ── Router helpers ─────────────────────────────────────────────────────────────

// Routing Designer is the sole authority for message flow.
const routingStore = webServer.routingStore;
staircaseLogic.bindRouting(routingStore);
function subscribeVisualRoutes() {
  for (const route of routingStore.routes) {
    if (route.enabled && (['mqtt', 'mqttDevice'].includes(route.from.type) || route.bidirectional)) {
      try { const ref = route.bidirectional && route.from.type === 'device' ? route.to : route.from; const endpoint = routingStore.resolve(ref, routingStore.endpoints); if (endpoint.topic) mqttHandler.subscribe(endpoint.topic); } catch (err) { console.warn('[ROUTING]', err.message); }
    }
  }
}
function routePayload(value, type, toKnx, transform) {
  if (transform?.kind === 'json') {
    let parsed;
    try { parsed = typeof value === 'string' ? JSON.parse(value) : value; }
    catch { return null; }
    let extracted = parsed;
    for (const segment of transform.path.split('.')) {
      if (!extracted || typeof extracted !== 'object' || !Object.hasOwn(extracted, segment)) return null;
      extracted = extracted[segment];
    }
    if (extracted === null || typeof extracted === 'object') return null;
    const raw = String(extracted);
    const mapped = transform.values?.[raw] ?? (Object.hasOwn(transform,'defaultValue') ? transform.defaultValue : extracted);
    return routePayload(mapped, type, toKnx, null);
  }
  if (transform?.kind === 'constant') return String(transform.value);
  if (transform?.kind === 'map') {
    const raw = String(value);
    const normalized = ['1','true','on'].includes(raw.toLowerCase()) ? 'ON' : ['0','false','off'].includes(raw.toLowerCase()) ? 'OFF' : raw;
    const mapped = transform.values[raw] ?? transform.values[normalized];
    return mapped === undefined ? (Object.hasOwn(transform,'defaultValue') ? String(transform.defaultValue) : raw) : String(mapped);
  }
  if (type !== 'boolean') return String(value);
  const v = String(value).trim().toLowerCase();
  if (['1','true','on','ein'].includes(v)) return toKnx ? '1' : 'true';
  if (['0','false','off','aus'].includes(v)) return toKnx ? '0' : 'false';
  return null;
}
const recentVisualPublishes = new Map();
function publishVisualRoute(topic, payload) {
  const key = topic + '\\0' + String(payload);
  recentVisualPublishes.set(key, Date.now());
  for (const [k, timestamp] of recentVisualPublishes) if (Date.now() - timestamp > 1500) recentVisualPublishes.delete(k);
  mqttHandler.publish(topic, payload);
}
function reverseRoutePayload(value, type, transform) {
  if (!transform) return routePayload(value, type, true, null);
  if (transform.kind !== 'map') return null;
  // First declared matching value wins; ambiguity is resolved deterministically.
  const match = Object.entries(transform.values).find(([, mapped]) => String(mapped) === String(value));
  return match ? String(match[0]) : routePayload(value, type, true, null);
}
knxHandler.on('groupValueWrite', ({ address, value }) => {
  for (const route of routingStore.routes) {
    if (!route.enabled || (route.from.type !== 'device' && !route.bidirectional)) continue;
    try {
      const reverse = route.bidirectional && route.from.type !== 'device';
      const source = routingStore.resolve(reverse ? route.to : route.from, routingStore.endpoints);
      if (source.address !== address) continue;
      const destination = routingStore.resolve(reverse ? route.from : route.to, routingStore.endpoints);
      const payload = reverse ? reverseRoutePayload(value, source.type, route.transform) : routePayload(value, source.type, false, route.transform);
      if (payload === null) continue;
      if (staircaseLogic.onRoute(route.id, value)) continue;
      if (!reverse && route.to.type === 'device') {
        if (!knxHandler.connected || source.address === destination.address) continue;
        const knxPayload = routePayload(value, source.type, true, route.transform);
        if (knxPayload === null || !knxHandler.write(destination.address, knxPayload)) continue;
        eventEmitter.emit('routing-traffic', { id: route.id, value: knxPayload, direction: 'KNX→KNX', timestamp: new Date().toISOString() });
      } else {
        publishVisualRoute(destination.topic, payload);
        eventEmitter.emit('routing-traffic', { id: route.id, value: payload, direction: 'KNX→MQTT', timestamp: new Date().toISOString() });
      }
    } catch (err) { console.warn('[ROUTING] Invalid KNX route:', err.message); }
  }
});
mqttHandler.on('message', ({ topic, value }) => {
  const echoKey = topic + '\\0' + String(value);
  if (recentVisualPublishes.has(echoKey) && Date.now() - recentVisualPublishes.get(echoKey) < 1500) { recentVisualPublishes.delete(echoKey); return; }
  for (const route of routingStore.routes) {
    if (!route.enabled || !(['mqtt', 'mqttDevice'].includes(route.from.type) || route.bidirectional)) continue;
    try {
      const reverse = route.bidirectional && route.from.type === 'device';
      const source = routingStore.resolve(reverse ? route.to : route.from, routingStore.endpoints);
      if (source.topic !== topic) continue;
      const destination = routingStore.resolve(reverse ? route.from : route.to, routingStore.endpoints);
      const payload = reverse ? reverseRoutePayload(value, destination.type, route.transform) : routePayload(value, source.type, true, route.transform);
      if (payload === null) continue;
      if (staircaseLogic.onRoute(route.id, value)) continue;
      if (!knxHandler.connected) continue;
      if (!knxHandler.write(destination.address, payload)) continue;
      eventEmitter.emit('routing-traffic', { id: route.id, value: payload, direction: 'MQTT→KNX', timestamp: new Date().toISOString() });
    } catch (err) { console.warn('[ROUTING] Invalid MQTT route:', err.message); }
  }
});
mqttHandler.on('connected', subscribeVisualRoutes);
eventEmitter.on('routing-changed', subscribeVisualRoutes);

// ── KNX → MQTT ─────────────────────────────────────────────────────────────────
knxHandler.on('groupValueWrite', ({ address, src, value, name }) => {
  const ga = config.groupAddresses.find(g => g.address === address);
  const configured = Boolean(ga);
  const topic = null;
  eventEmitter.emit('traffic', {
    direction: 'KNX→MQTT',
    address,
    name: name || address,
    topic,
    value: String(value),
    dpt: ga ? ga.dpt : undefined,
    src,
    configured,
    timestamp: new Date().toISOString(),
  });
});

// Dashboard diagnostic write: direct KNX send, no MQTT loop and no optimistic confirmation.
eventEmitter.on('device-setpoint-write', ({ address, value, respond }) => {
  if (!knxHandler.connected) return respond({ ok: false, status: 503, error: 'KNX disconnected' });
  const ok = knxHandler.write(address, String(value));
  if (!ok) return respond({ ok: false, status: 502, error: 'KNX write failed' });
  eventEmitter.emit('traffic', {
    direction: 'WEB→KNX', address,
    name: (config.groupAddresses.find(g => g.address === address) || {}).name || address,
    topic: null, value: String(value), dpt: '9.001', configured: true,
    outbound: true, timestamp: new Date().toISOString(),
  });
  respond({ ok: true, status: 202, message: 'Write sent to KNX library; bus/device confirmation pending' });
});

// Switch command: send only; state is exclusively derived from status group address.
eventEmitter.on('device-switch-write', ({ address, value, respond }) => {
  if (!knxHandler.connected) return respond({ ok: false, status: 503, error: 'KNX disconnected' });
  const raw = value ? '1' : '0';
  const ok = knxHandler.write(address, raw);
  if (!ok) return respond({ ok: false, status: 502, error: 'KNX write failed' });
  eventEmitter.emit('traffic', {
    direction: 'WEB→KNX', address,
    name: (config.groupAddresses.find(g => g.address === address) || {}).name || address,
    topic: null, value: raw, dpt: '1.001', configured: true,
    outbound: true, timestamp: new Date().toISOString(),
  });
  respond({ ok: true, status: 202, message: 'Switch command submitted; status feedback pending' });
});

// ── Status events ──────────────────────────────────────────────────────────────
knxHandler.on('connected', () =>
  eventEmitter.emit('status', { service: 'KNX', connected: true })
);
knxHandler.on('disconnected', () =>
  eventEmitter.emit('status', { service: 'KNX', connected: false })
);
mqttHandler.on('connected', () => eventEmitter.emit('status', { service: 'MQTT', connected: true }));
mqttHandler.on('disconnected', () =>
  eventEmitter.emit('status', { service: 'MQTT', connected: false })
);

// Allow dashboard-triggered MQTT restart (refreshes connection + subscriptions)
eventEmitter.on('mqtt-restart', () => mqttHandler.restart());
